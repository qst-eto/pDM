import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class OnlineRoomTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db_path = Path(self.temp.name) / 'cards.db'
        with sqlite3.connect(self.db_path) as db:
            db.execute('CREATE TABLE cardlist (cardname TEXT, packname TEXT, typetxt TEXT, civiltxt TEXT, costtxt TEXT, imagefile TEXT)')
            db.executemany('INSERT INTO cardlist VALUES (?, ?, ?, ?, ?, ?)', [
                ('ホストカード', 'host', 'クリーチャー', '火', '3', ''),
                ('ゲストカード', 'guest', 'クリーチャー', '水', '4', ''),
                ('超次元', 'psychic', 'サイキック・クリーチャー', '闇', '5', ''),
                ('GR', 'gr', 'GRクリーチャー', '自然', '2', ''),
            ])
        db.close()
        self.db_patch = patch.object(server, 'DATABASE_PATH', self.db_path)
        self.db_patch.start()
        self.addCleanup(self.db_patch.stop)
        server.TABLES.clear()
        self.addCleanup(server.TABLES.clear)

    def call(self, path, data=None, token='', expected=200):
        handler = object.__new__(server.SimulatorHandler)
        handler.path = path
        body = json.dumps(data or {}).encode() if data is not None else b''
        handler.headers = {'Content-Length': str(len(body))}
        if token:
            handler.headers['X-Player-Token'] = token
        handler.rfile = io.BytesIO(body)
        captured = []
        handler.send_json = lambda payload, status=200: captured.append((payload, int(status)))
        if data is None:
            handler.do_GET()
        else:
            handler.do_POST()
        payload, status = captured[0]
        self.assertEqual(status, expected, payload)
        return json.loads(json.dumps(payload))

    def create_and_join(self):
        host = self.call('/api/rooms', {'player_name': 'ホスト', 'deck': [1] * 40, 'extra': [3]}, expected=201)
        room = host['room_id']
        guest = self.call(f'/api/rooms/{room}/join', {'player_name': 'ゲスト', 'deck': [2] * 40, 'gachi': [4] * 12})
        return room, host['player_token'], guest['player_token']

    def test_waiting_room_is_empty_and_requires_token(self):
        host = self.call('/api/rooms', {'player_name': 'ホスト', 'deck': [1] * 40}, expected=201)
        self.assertRegex(host['room_id'], r'^\d{6}$')
        table = host['table']
        self.assertEqual(table['status'], 'waiting')
        self.assertEqual(sum(table['players'][1]['counts'].values()), 0)
        self.assertEqual(table['players'][1]['shield_count'], 0)
        self.call(f"/api/tables/{host['room_id']}", expected=403)
        own = self.call(f"/api/tables/{host['room_id']}", token=host['player_token'])['table']
        self.assertEqual(own['players'][0]['name'], 'ホスト')
        self.call(f"/api/tables/{host['room_id']}/commands", {'command': 'draw', 'player': 0}, token=host['player_token'], expected=403)

    def test_each_viewer_is_at_bottom_and_private_cards_stay_private(self):
        room, host_token, guest_token = self.create_and_join()
        host = self.call(f'/api/tables/{room}', token=host_token)['table']
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertEqual([player['name'] for player in host['players']], ['ホスト', 'ゲスト'])
        self.assertEqual([player['name'] for player in guest['players']], ['ゲスト', 'ホスト'])
        self.assertTrue(all(item['card'] for item in host['players'][0]['zones']['hand']))
        self.assertTrue(all(item['card'] is None for item in host['players'][1]['zones']['hand']))
        self.assertTrue(all(item['card'] for item in guest['players'][0]['zones']['hand']))
        self.assertTrue(all(item['card'] is None for item in guest['players'][1]['zones']['hand']))
        self.assertTrue(all(item['card'] is None for item in host['players'][0]['shields']))
        self.assertTrue(all(item['card'] is None for item in host['players'][1]['shields']))
        self.assertTrue(all(item['card'] is None for item in guest['players'][0]['zones']['gachi']))
        self.assertEqual(host['players'][0]['zones']['extra'][0]['card']['id'], 3)
        self.assertEqual(guest['players'][1]['zones']['extra'][0]['card']['id'], 3)
        self.call(f'/api/rooms/{room}/join', {'player_name': '3人目', 'deck': [1] * 40}, expected=409)

    def test_own_move_syncs_and_opponent_operations_are_rejected(self):
        room, host_token, guest_token = self.create_and_join()
        host = self.call(f'/api/tables/{room}', token=host_token)['table']
        host_hand = host['players'][0]['zones']['hand'][0]
        moved = self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [host_hand['uid']], 'zone': 'battle', 'target_player': 0,
        }, token=host_token)['table']
        self.assertEqual(moved['players'][0]['zones']['battle'][-1]['card']['id'], 1)
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertEqual(guest['players'][1]['zones']['battle'][-1]['card']['id'], 1)
        self.call(f'/api/tables/{room}/commands', {
            'command': 'flip', 'card_ids': [host_hand['uid']], 'value': False,
        }, token=host_token)
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertIsNone(guest['players'][1]['zones']['battle'][-1]['card'])
        self.call(f'/api/tables/{room}/commands', {
            'command': 'flip', 'card_ids': [host_hand['uid']], 'value': True,
        }, token=host_token)
        guest_uid = guest['players'][0]['zones']['hand'][0]['uid']
        self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [guest_uid], 'zone': 'battle', 'target_player': 0,
        }, token=host_token, expected=403)
        self.call(f'/api/tables/{room}/commands', {
            'command': 'view_deck', 'player': 1,
        }, token=host_token, expected=403)

    def test_turn_is_relative_to_each_viewer(self):
        room, host_token, guest_token = self.create_and_join()
        self.call(f'/api/tables/{room}/commands', {'command': 'end_turn'}, token=guest_token, expected=403)
        host = self.call(f'/api/tables/{room}/commands', {'command': 'end_turn'}, token=host_token)['table']
        self.assertEqual(host['active_player'], 1)
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertEqual(guest['active_player'], 0)


if __name__ == '__main__':
    unittest.main()
