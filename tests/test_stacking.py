"""Run with python -B -m unittest discover -s tests; no server or database required."""
import copy
import unittest

import server


class StackCardsTests(unittest.TestCase):
    def setUp(self):
        self.table = {'players': [server.empty_player('self'), server.empty_player('opponent')], 'log': []}
        self.player = self.table['players'][0]
        self.front = server.make_instance({'id': 1}, True)
        self.back = server.make_instance({'id': 2}, False)
        self.back['tapped'] = True
        self.battle = server.make_instance({'id': 3}, True)
        self.shield = server.make_instance({'id': 4}, False)
        self.player['zones']['hand'] = [self.front, self.back]
        self.player['zones']['battle'] = [self.battle]
        self.player['shields'] = [self.shield]

    def stack(self, sources, target, position):
        return server.apply_command(self.table, 'stack', {
            'card_ids': [item['uid'] for item in sources], 'target_id': target['uid'], 'position': position,
        })

    def test_mixed_hand_faces_and_tapped_state_preserved(self):
        self.assertEqual(self.stack([self.front, self.back], self.battle, 'above'), (True, ''))
        self.assertEqual(self.player['zones']['hand'], [])
        self.assertEqual(self.battle['stack']['above'], [self.front, self.back])
        self.assertTrue(self.front['face_up'])
        self.assertFalse(self.back['face_up'])
        self.assertTrue(self.back['tapped'])

    def test_face_up_card_on_face_down_shield_is_visible(self):
        self.assertEqual(self.stack([self.front], self.shield, 'above'), (True, ''))
        public = server.public_player(self.player, 0)['shields'][0]
        self.assertIsNone(public['card'])
        self.assertFalse(public['face_up'])
        self.assertEqual(public['stack']['above'][0]['card'], self.front['card'])
        self.assertTrue(public['stack']['above'][0]['face_up'])

    def test_below_keeps_target_on_top_and_private_cards_hidden(self):
        self.assertEqual(self.stack([self.back], self.shield, 'below'), (True, ''))
        public = server.public_player(self.player, 0)['shields'][0]
        self.assertEqual(public['stack']['above'], [])
        self.assertIsNone(public['stack']['below'][0]['card'])
        self.assertEqual(server.count_stack_items(self.player['shields']), 2)

    def test_invalid_targets_do_not_mutate_cards(self):
        opponent = server.make_instance({'id': 5}, True)
        self.table['players'][1]['zones']['battle'].append(opponent)
        for target, position in [(self.back, 'above'), (opponent, 'below'), (self.shield, 'invalid')]:
            before = copy.deepcopy(self.table)
            self.assertFalse(self.stack([self.front], target, position)[0])
            self.assertEqual(self.table, before)

    def test_cannot_create_stack_cycle(self):
        self.assertTrue(self.stack([self.front], self.battle, 'above')[0])
        before = copy.deepcopy(self.table)
        self.assertFalse(self.stack([self.battle], self.front, 'above')[0])
        self.assertEqual(self.table, before)

    def test_move_parent_and_nested_card_together_moves_all_cards_unstacked(self):
        self.assertTrue(self.stack([self.front], self.battle, 'above')[0])
        child = self.battle['stack']['above'][0]
        ok, error = server.move_cards(self.table, [self.battle['uid'], child['uid']], 'mana', 0)
        self.assertEqual((ok, error), (True, ''))
        self.assertEqual(self.player['zones']['battle'], [])
        self.assertEqual([item['uid'] for item in self.player['zones']['mana']], [self.battle['uid'], self.front['uid']])
        self.assertTrue(all(not item['stack']['below'] and not item['stack']['above'] for item in self.player['zones']['mana']))

    def test_moving_a_stack_to_mana_unstacks_every_card(self):
        self.assertTrue(self.stack([self.front, self.back], self.battle, 'above')[0])
        ok, error = server.move_cards(self.table, [self.battle['uid']], 'mana', 0)
        self.assertEqual((ok, error), (True, ''))
        mana = self.player['zones']['mana']
        self.assertEqual(len(mana), 3)
        self.assertEqual(server.count_stack_items(mana), 3)
        self.assertTrue(all(not item['stack']['below'] and not item['stack']['above'] for item in mana))


if __name__ == '__main__':
    unittest.main()
