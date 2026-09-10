import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


def plain_card(card_id=1, name='カード'):
    return {
        'id': card_id,
        'cardname': name,
        'packname': '',
        'typetxt': 'クリーチャー',
        'civiltxt': '火',
        'costtxt': '3',
        'image_files': [],
        'image_url': f'/api/cards/{card_id}/image',
    }


class LatestFeatureTests(unittest.TestCase):
    def test_image_choice_is_loaded_and_exposed(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'cards.db'
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE cardlist (cardname TEXT, packname TEXT, typetxt TEXT, civiltxt TEXT, costtxt TEXT, imagefile TEXT)')
                connection.execute('INSERT INTO cardlist VALUES (?, ?, ?, ?, ?, ?)', (
                    '別画像カード', 'pack', 'クリーチャー', '水', '4', json.dumps(['one.jpg', 'two.jpg']),
                ))
            connection.close()
            with patch.object(server, 'DATABASE_PATH', database):
                loaded = server.load_deck_config({'cards': [{'id': 1, 'image_index': 1}]})['cards'][0]
                view = server.card_view(loaded)
            self.assertEqual(view['image_index'], 1)
            self.assertEqual(len(view['image_options']), 2)
            self.assertTrue(view['image_url'].endswith('?index=1'))

    def test_note_targets_top_and_stack_can_move_as_one_group(self):
        table = {'players': [server.empty_player('self'), server.empty_player('opponent')], 'log': []}
        root = server.make_instance(plain_card(1, '下'))
        top = server.make_instance(plain_card(2, '上'))
        table['players'][0]['zones']['battle'] = [root]
        table['players'][0]['zones']['hand'] = [top]
        self.assertTrue(server.stack_cards(table, [top['uid']], root['uid'])[0])
        self.assertTrue(server.apply_command(table, 'set_note', {'card_ids': [root['uid']], 'note': '最上面'})[0])
        self.assertEqual(root['note'], '')
        self.assertEqual(top['note'], '最上面')
        self.assertTrue(server.move_cards(table, [root['uid']], 'mana', preserve_stack=True)[0])
        self.assertEqual(len(table['players'][0]['zones']['mana']), 1)
        self.assertEqual(server.count_stack_items(table['players'][0]['zones']['mana']), 2)
        self.assertTrue(server.move_cards(table, [top['uid']], 'graveyard')[0])
        self.assertEqual(root['stack']['above'], [])
        self.assertEqual(table['players'][0]['zones']['graveyard'][0]['uid'], top['uid'])

    def test_private_waiting_card_is_known_only_to_its_owner(self):
        table = {'players': [server.empty_player('self'), server.empty_player('opponent')], 'log': []}
        item = server.make_instance(plain_card())
        table['players'][0]['zones']['hand'] = [item]
        self.assertTrue(server.move_cards(table, [item['uid']], 'waiting', position='keep_face_down')[0])
        owner = server.public_player(table['players'][0], 0)['zones']['waiting'][0]
        opponent = server.public_player(table['players'][0], 1)['zones']['waiting'][0]
        self.assertEqual(owner['card']['id'], 1)
        self.assertTrue(owner['private_to_opponent'])
        self.assertIsNone(opponent['card'])
        self.assertFalse(opponent['face_up'])

    def test_restart_rebuilds_starting_state_and_repeats_coin_toss(self):
        first_card = plain_card(1, '一人目')
        second_card = plain_card(2, '二人目')
        table = server.new_online_room('一人目', [first_card])
        table['initial_setups'][1] = {'name': '二人目', 'cards': server.fill_deck([second_card]), 'special': {}}
        table['players'][1] = server.prepare_player('二人目', [second_card])
        table['status'] = 'ready'
        server.choose_first_player(table)
        old_uid = table['players'][0]['zones']['hand'][0]['uid']
        server.move_cards(table, [old_uid], 'battle')
        ok, error = server.restart_table(table)
        self.assertEqual((ok, error), (True, ''))
        self.assertEqual(table['turn'], 1)
        self.assertIn(table['active_player'], (0, 1))
        self.assertEqual(len(table['players'][0]['zones']['hand']), 5)
        self.assertEqual(len(table['players'][0]['zones']['deck']), 30)
        self.assertEqual(len(table['players'][0]['shields']), 5)
        self.assertNotEqual(table['players'][0]['zones']['hand'][0]['uid'], old_uid)
        self.assertIn('コイントス', table['log'][-1])

    def test_drag_drop_stacking_can_target_non_battle_zone(self):
        table = {'players': [server.empty_player('self'), server.empty_player('opponent')], 'log': []}
        source = server.make_instance(plain_card(1))
        target = server.make_instance(plain_card(2))
        table['players'][0]['zones']['hand'] = [source, target]
        self.assertTrue(server.stack_cards(table, [source['uid']], target['uid'], allow_any_zone=True)[0])
        self.assertEqual(target['stack']['above'][0]['uid'], source['uid'])


if __name__ == '__main__':
    unittest.main()
