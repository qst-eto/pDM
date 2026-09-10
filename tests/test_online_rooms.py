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
        spectator = self.call(f'/api/rooms/{room}/join', {
            'player_name': '3人目', 'deck': [1], 'gachi': [4],
        })
        self.assertEqual(spectator['viewer_role'], 'spectator')
        self.assertEqual(spectator['table']['viewer_role'], 'spectator')
        self.assertEqual([player['name'] for player in spectator['table']['players']], ['ホスト', 'ゲスト'])
        self.call(f'/api/tables/{room}/commands', {'command': 'end_turn'}, token=spectator['player_token'], expected=403)

    def test_hand_visibility_has_separate_opponent_and_spectator_audiences(self):
        room, host_token, guest_token = self.create_and_join()
        spectator = self.call(f'/api/rooms/{room}/join', {'player_name': '観戦者'})
        spectator_token = spectator['player_token']
        host_hand_uid = self.call(f'/api/tables/{room}', token=host_token)['table']['players'][0]['zones']['hand'][0]['uid']
        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_note', 'card_ids': [host_hand_uid], 'note': '非公開メモ',
        }, token=host_token)
        self.assertTrue(all(item['card'] is None for item in spectator['table']['players'][0]['zones']['hand']))
        self.assertTrue(all(item['card'] is None for item in spectator['table']['players'][1]['zones']['hand']))

        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_visibility', 'player': 0, 'audience': 'spectators', 'value': True,
        }, token=host_token)
        spectator_view = self.call(f'/api/tables/{room}', token=spectator_token)['table']
        guest_view = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertTrue(all(item['card'] for item in spectator_view['players'][0]['zones']['hand']))
        self.assertTrue(all(item['card'] is None for item in guest_view['players'][1]['zones']['hand']))
        self.assertTrue(all(not item['note'] for item in guest_view['players'][1]['zones']['hand']))

        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_visibility', 'player': 0, 'audience': 'opponent', 'value': True,
        }, token=host_token)
        guest_view = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertTrue(all(item['card'] for item in guest_view['players'][1]['zones']['hand']))
        self.assertEqual(next(item for item in guest_view['players'][1]['zones']['hand'] if item['uid'] == host_hand_uid)['note'], '非公開メモ')
        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_visibility', 'player': 0, 'audience': 'spectators', 'value': False,
        }, token=host_token)
        spectator_view = self.call(f'/api/tables/{room}', token=spectator_token)['table']
        self.assertTrue(all(item['card'] is None for item in spectator_view['players'][0]['zones']['hand']))

    def test_selected_hand_cards_can_be_shown_only_to_the_opponent(self):
        room, host_token, guest_token = self.create_and_join()
        spectator_token = self.call(f'/api/rooms/{room}/join', {'player_name': '観戦者'})['player_token']
        host_view = self.call(f'/api/tables/{room}', token=host_token)['table']
        host_hand = host_view['players'][0]['zones']['hand']
        shown_uid = host_hand[0]['uid']

        owner_view = self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_card_visibility', 'card_ids': [shown_uid], 'value': True,
        }, token=host_token)['table']
        shown_owner_card = next(item for item in owner_view['players'][0]['zones']['hand'] if item['uid'] == shown_uid)
        self.assertTrue(shown_owner_card['shown_to_opponent'])

        guest_view = self.call(f'/api/tables/{room}', token=guest_token)['table']
        guest_host_hand = guest_view['players'][1]['zones']['hand']
        self.assertEqual([item['uid'] for item in guest_host_hand if item['card']], [shown_uid])
        self.assertTrue(all(not item['shown_to_opponent'] for item in guest_host_hand))

        spectator_view = self.call(f'/api/tables/{room}', token=spectator_token)['table']
        self.assertTrue(all(item['card'] is None for item in spectator_view['players'][0]['zones']['hand']))

        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_card_visibility', 'card_ids': [shown_uid], 'value': False,
        }, token=host_token)
        guest_view = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertTrue(all(item['card'] is None for item in guest_view['players'][1]['zones']['hand']))

        self.call(f'/api/tables/{room}/commands', {
            'command': 'set_hand_card_visibility', 'card_ids': [shown_uid], 'value': True,
        }, token=host_token)
        self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [shown_uid], 'zone': 'battle', 'target_player': 0,
        }, token=host_token)
        returned = self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [shown_uid], 'zone': 'hand', 'target_player': 0,
        }, token=host_token)['table']
        returned_card = next(item for item in returned['players'][0]['zones']['hand'] if item['uid'] == shown_uid)
        self.assertFalse(returned_card['shown_to_opponent'])
        guest_view = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertIsNone(next(item for item in guest_view['players'][1]['zones']['hand'] if item['uid'] == shown_uid)['card'])

    def test_waiting_zone_and_shared_card_note(self):
        room, host_token, guest_token = self.create_and_join()
        host = self.call(f'/api/tables/{room}', token=host_token)['table']
        item = host['players'][0]['zones']['hand'][0]
        self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [item['uid']], 'zone': 'waiting', 'target_player': 0,
        }, token=host_token)
        updated = self.call(f'/api/tables/{room}/commands', {
            'command': 'set_note', 'card_ids': [item['uid']], 'note': '次のターンに使う',
        }, token=host_token)['table']
        self.assertEqual(updated['players'][0]['zones']['waiting'][0]['note'], '次のターンに使う')
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertEqual(guest['players'][1]['zones']['waiting'][0]['note'], '次のターンに使う')
        self.assertEqual(guest['players'][1]['zones']['waiting'][0]['card']['id'], 1)

    def test_private_waiting_and_restart_are_synchronized(self):
        room, host_token, guest_token = self.create_and_join()
        spectator_token = self.call(f'/api/rooms/{room}/join', {'player_name': '観戦者'})['player_token']
        host = self.call(f'/api/tables/{room}', token=host_token)['table']
        item = host['players'][0]['zones']['hand'][0]
        owner = self.call(f'/api/tables/{room}/commands', {
            'command': 'move', 'card_ids': [item['uid']], 'zone': 'waiting',
            'target_player': 0, 'keep_face_down': True,
        }, token=host_token)['table']
        private = owner['players'][0]['zones']['waiting'][0]
        self.assertEqual(private['card']['id'], 1)
        self.assertTrue(private['private_to_opponent'])
        guest = self.call(f'/api/tables/{room}', token=guest_token)['table']
        self.assertIsNone(guest['players'][1]['zones']['waiting'][0]['card'])
        spectator = self.call(f'/api/tables/{room}', token=spectator_token)['table']
        self.assertIsNone(spectator['players'][0]['zones']['waiting'][0]['card'])

        restarted = self.call(f'/api/tables/{room}/commands', {
            'command': 'restart_game',
        }, token=host_token)['table']
        self.assertEqual(restarted['turn'], 1)
        self.assertEqual(restarted['players'][0]['counts']['waiting'], 0)
        self.assertEqual(restarted['players'][0]['counts']['hand'], 5)
        self.assertEqual(restarted['players'][0]['counts']['deck'], 30)
        self.assertNotIn(item['uid'], [card['uid'] for card in restarted['players'][0]['zones']['hand']])
        self.assertIn('コイントス', restarted['start_message'])

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
        host_before = self.call(f'/api/tables/{room}', token=host_token)['table']
        self.assertEqual(host_before['start_method'], 'coin')
        self.assertIn(host_before['first_player'], (0, 1))
        active_token, waiting_token = (host_token, guest_token) if host_before['active_player'] == 0 else (guest_token, host_token)
        self.call(f'/api/tables/{room}/commands', {'command': 'end_turn'}, token=waiting_token, expected=403)
        active_view = self.call(f'/api/tables/{room}/commands', {'command': 'end_turn'}, token=active_token)['table']
        self.assertEqual(active_view['active_player'], 1)
        waiting_view = self.call(f'/api/tables/{room}', token=waiting_token)['table']
        self.assertEqual(waiting_view['active_player'], 0)


if __name__ == '__main__':
    unittest.main()
