import copy
import json
import io
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import server


class SpecialDeckTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.db_path = root / 'cards.db'
        with sqlite3.connect(self.db_path) as db:
            db.execute('CREATE TABLE cardlist (cardname TEXT, packname TEXT, typetxt TEXT, civiltxt TEXT, costtxt TEXT, imagefile TEXT)')
            db.executemany('INSERT INTO cardlist VALUES (?, ?, ?, ?, ?, ?)', [
                ('通常', 'main', 'クリーチャー', '水', '', ''),
                ('超次元A', 'same pack', 'サイキック・クリーチャー', '火', '', ''),
                ('超次元B', 'same pack', 'サイキック・クリーチャー', '自然', '', ''),
                ('ツイン / 呪文', 'twin pack', 'クリーチャー', '水', '', ''),
                ('ツイン / 呪文', 'twin pack', '呪文', '火', '', ''),
                ('GR', 'gr', 'GRクリーチャー', '光', '', ''),
                ('開始時', 'start', 'クリーチャー', '闇', '', ''),
                ('三面A', 'three', 'ドラグハート・ウエポン', '火', '', ''),
                ('三面B', 'three', 'ドラグハート・フォートレス', '火', '', ''),
                ('三面C', 'three', 'ドラグハート・クリーチャー', '火', '', ''),
                ('紛らわしい / ツイン', 'same pack', 'サイキック・クリーチャー', '水', '', ''),
                ('別パック', 'same pack ', 'サイキック・クリーチャー', '光', '', ''),
                ('覚醒小', 'three stage', 'サイキック・クリーチャー', '火', '', ''),
                ('覚醒中', 'three stage', 'サイキック・クリーチャー', '火', '', ''),
                ('覚醒大', 'three stage', 'サイキック・クリーチャー', '火', '', ''),
                ('サイキックリンク', 'link stage', 'サイキック・クリーチャー', '水', '', ''),
                ('サイキックリンク後', 'link stage', 'サイキック・クリーチャー', '水', '', ''),
            ])
            db.execute("UPDATE cardlist SET costtxt = '4' WHERE cardname = '覚醒小'")
            db.execute("UPDATE cardlist SET costtxt = '6' WHERE cardname = '覚醒中'")
            db.execute("UPDATE cardlist SET costtxt = '15' WHERE cardname = '覚醒大'")
            db.execute("UPDATE cardlist SET costtxt = '7' WHERE cardname LIKE 'サイキックリンク%'")
        db.close()
        for name, value in [('DATABASE_PATH', self.db_path), ('DECK_DIRECTORY', root / 'decks')]:
            patcher = patch.object(server, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def config(self, **changes):
        return dict({'cards': [1] * 40, 'extra': [3, 2], 'gachi': [6] * 12, 'battle': [7]}, **changes)

    def table(self):
        config = server.load_deck_config(self.config(), for_start=True)
        return server.new_table('self', config['cards'], config['cards'], config)

    def test_start_placement_and_shuffle_only_main_and_gr(self):
        config = server.load_deck_config(self.config(), for_start=True)
        calls = []
        def shuffle(cards):
            calls.append([card['id'] for card in cards])
            cards.reverse()
        with patch.object(server.RANDOM_SOURCE, 'shuffle', side_effect=shuffle):
            table = server.new_table('self', config['cards'], config['cards'], config, config)
        self.assertEqual([len(cards) for cards in calls], [40, 40, 12, 12])
        for index, player in enumerate(table['players']):
            self.assertEqual([item['card']['id'] for item in player['zones']['extra']], [3, 2])
            self.assertEqual([item['card']['id'] for item in player['zones']['battle']], [7])
            self.assertEqual(len(player['zones']['gachi']), 12)
            self.assertTrue(all(not item['face_up'] for item in player['zones']['gachi']))
            public = server.public_player(player, index)
            self.assertTrue(all(item['card'] is None and not item['face_up'] and item['home_zone'] == 'gachi' for item in public['zones']['gachi']))
            ordinary = player['zones']['deck'] + player['zones']['hand'] + player['shields']
            self.assertEqual(len(ordinary), 40)
            self.assertTrue(all(item['card']['id'] == 1 for item in ordinary))

    def test_exact_pack_pair_and_twin_exclusion(self):
        self.assertIsNone(server.card_home_zone(server.get_card(8)))
        self.assertEqual([option['id'] for option in server.get_card(2)['face_options']], [3])
        self.assertEqual([option['id'] for option in server.get_card(3)['face_options']], [2])
        for card_id in (1, 4, 5, 11, 12):
            self.assertEqual(server.get_card(card_id)['face_options'], [])

    def test_three_stage_exposes_adjacent_cost_directions(self):
        small, middle, large = (server.get_card(index) for index in (13, 14, 15))
        self.assertEqual([option['id'] for option in small['face_actions']['up']], [14])
        self.assertEqual(small['face_actions']['down'], [])
        self.assertEqual([option['id'] for option in middle['face_actions']['up']], [15])
        self.assertEqual([option['id'] for option in middle['face_actions']['down']], [13])
        self.assertEqual([option['id'] for option in large['face_actions']['down']], [14])
        self.assertEqual(large['face_actions']['up'], [])
        link = server.get_card(16)
        self.assertEqual(link['face_actions'], {'up': [], 'down': []})
        self.assertEqual([option['id'] for option in link['face_options']], [17])

    def test_turn_over_preserves_instance_tap_stack_and_origin(self):
        table = self.table()
        item = table['players'][0]['zones']['extra'][0]
        self.assertTrue(server.move_cards(table, [item['uid']], 'battle')[0])
        item['tapped'] = True
        item['stack']['below'].append(server.make_instance(server.get_card(1)))
        original = copy.deepcopy(item)
        self.assertTrue(server.apply_command(table, 'turn_over', {'card_ids': [item['uid']]})[0])
        self.assertEqual(item['card']['id'], 2)
        for key in ('uid', 'home_zone', 'tapped', 'stack'):
            self.assertEqual(item[key], original[key])
        self.assertTrue(server.apply_command(table, 'turn_over', {'card_ids': [item['uid']]})[0])
        self.assertEqual(item['card']['id'], 3)
        before = copy.deepcopy(table)
        self.assertFalse(server.apply_command(table, 'turn_over', {'card_ids': [item['uid']], 'face_id': 4})[0])
        self.assertEqual(table, before)

    def test_multi_face_requires_explicit_candidate(self):
        table = self.table()
        item = server.make_instance(server.get_card(13))
        table['players'][0]['zones']['extra'].append(item)
        self.assertFalse(server.apply_command(table, 'turn_over', {'card_ids': [item['uid']]})[0])
        self.assertTrue(server.apply_command(table, 'turn_over', {'card_ids': [item['uid']], 'face_id': 14})[0])
        self.assertEqual(item['card']['id'], 14)

    def test_all_forbidden_destinations_are_atomic_including_stacks(self):
        for home in ('extra', 'gachi'):
            for target in ('deck', 'hand', 'mana', 'graveyard', 'shields', 'gachi' if home == 'extra' else 'extra'):
                table = self.table()
                player = table['players'][0]
                special = player['zones'][home][0]
                ordinary = player['zones']['battle'][0]
                self.assertTrue(server.stack_cards(table, [special['uid']], ordinary['uid'])[0])
                before = copy.deepcopy(table)
                self.assertFalse(server.move_cards(table, [ordinary['uid']], target)[0], (home, target))
                self.assertEqual(table, before)
            table = self.table()
            item = table['players'][0]['zones'][home][0]
            for target in ('battle', 'abyss', home):
                self.assertTrue(server.move_cards(table, [item['uid']], target)[0])
                self.assertEqual(item['home_zone'], home)
            self.assertEqual(item['face_up'], home == 'extra')

    def test_cannot_stack_special_on_shield_or_mix_origins_on_return(self):
        table = self.table()
        player = table['players'][0]
        gr = player['zones']['gachi'][0]
        extra = player['zones']['extra'][0]
        before = copy.deepcopy(table)
        self.assertFalse(server.stack_cards(table, [gr['uid']], player['shields'][0]['uid'])[0])
        self.assertEqual(table, before)
        self.assertFalse(server.move_cards(table, [gr['uid'], extra['uid']], 'extra')[0])
        self.assertEqual(table, before)

    def test_counts_drafts_exceptions_and_legacy_special_separation(self):
        for changes in ({'extra': [2] * 9}, {'gachi': [6] * 11}, {'gachi': [6] * 13}, {'gachi': [6] * 12, 'battle': [6]}):
            with self.assertRaises(ValueError):
                server.load_deck_config(self.config(**changes), for_start=True)
            server.load_deck_config(self.config(**changes))  # Incomplete drafts can be saved.
            server.load_deck_config(self.config(**changes, allow_size_exceptions=True), for_start=True)
        server.load_deck_config(self.config(extra=[], gachi=[]), for_start=True)
        with self.assertRaises(ValueError):
            server.load_deck_config(self.config(extra=[4]))
        legacy = server.load_deck_config({'cards': [1, 2, 6]})
        self.assertEqual([card['id'] for card in legacy['cards']], [1])
        self.assertEqual([card['id'] for card in legacy['extra']], [2])
        self.assertEqual([card['id'] for card in legacy['gachi']], [6])

    def test_saved_roundtrip_and_start_api_validation(self):
        def call(path, data=None, expected_status=None):
            # Exercise the actual handlers and serialization without opening sockets.
            handler = object.__new__(server.SimulatorHandler)
            handler.path = path
            body = json.dumps(data).encode() if data is not None else b''
            handler.headers = {'Content-Length': str(len(body))}
            handler.rfile = io.BytesIO(body)
            captured = []
            handler.send_json = lambda payload, status=200: captured.append((payload, status))
            if data is None:
                handler.do_GET()
            else:
                handler.do_POST()
            payload, status = captured[0]
            self.assertEqual(status, expected_status or (201 if path in ('/api/decks', '/api/tables') and data is not None else 200))
            return json.loads(json.dumps(payload))
        saved = call('/api/decks', self.config(name='特殊枠テスト'))['deck']
        loaded = call('/api/decks/' + saved['id'])['deck']
        for key in ('cards', 'extra', 'gachi', 'battle'):
            self.assertEqual(loaded[key], self.config()[key])
        self.assertEqual(call('/api/decks')['decks'][0]['gachi_count'], 12)
        table = call('/api/tables', dict(deck=loaded['cards'], extra=loaded['extra'], gachi=loaded['gachi'], battle=loaded['battle']))['table']
        self.addCleanup(server.TABLES.pop, table['id'], None)
        self.assertEqual(table['players'][0]['counts']['deck'], 30)
        self.assertEqual(table['players'][0]['counts']['gachi'], 12)
        self.assertIn('12枚', call('/api/tables', {'deck': [1], 'gachi': [6]}, expected_status=400)['error'])
        self.assertTrue(all(card['home_zone'] == 'gachi' for card in call('/api/cards?section=gachi')['cards']))
        self.assertTrue(all(card['home_zone'] is None for card in call('/api/cards?section=deck')['cards']))


if __name__ == '__main__':
    unittest.main()
