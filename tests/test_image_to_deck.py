import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import image_to_deck as cli
import server


def result_fixture():
    rows = []
    for position, card_id, image_index, status, home in [
            (1, 101, 1, 'matched', None), (2, 101, 0, 'ambiguous', None),
            (3, 209, 0, 'matched', 'gachi'), (4, 303, 0, 'unknown', 'extra')]:
        rows.append({'position': position, 'status': status, 'requires_review': status != 'matched',
                     'candidates': [{'card': {'id': card_id, 'home_zone': home, 'cardname': '試験カード'},
                                     'image_index': image_index, 'score': .8}]})
    return {'cards': rows, 'detected_count': 4}


class ImageToDeckTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = self.root / 'pDM.db'
        with sqlite3.connect(self.db) as db:
            db.execute('CREATE TABLE cardlist(cardname TEXT, imagefile TEXT, typetxt TEXT, packname TEXT)')
            for id, kind in [(101, 'クリーチャー'), (209, 'GRクリーチャー'), (303, 'サイキック・クリーチャー')]:
                db.execute('INSERT INTO cardlist(rowid,cardname,imagefile,typetxt,packname) VALUES(?,?,?,?,?)',
                           (id, 'カード{}'.format(id), json.dumps(['first.png', 'second.png']), kind, ''))
        db.close()
        self.input = self.root / '日本語のデッキ.png'
        self.input.write_bytes(b'input passed to the scanner')
        self.patches = [patch.object(server, 'DATABASE_PATH', self.db), patch.object(server, 'PROJECT_ROOT', self.root),
                        patch.object(server, 'DECK_DIRECTORY', self.root / 'saved_decks')]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temporary.cleanup()

    def test_default_generates_loadable_deck_with_printings_and_special_sections(self):
        with patch.object(cli, 'analyze_image', return_value=result_fixture()), patch.object(server, 'ThreadingHTTPServer') as http:
            result = cli.convert_image(self.input, name='画像からのデッキ')
        http.assert_not_called()
        output = Path(result['output'])
        deck = json.loads(output.read_text(encoding='utf-8'))
        self.assertEqual(deck['format'], 'dm-table-forge-deck')
        self.assertEqual(deck['version'], 4)
        self.assertEqual(deck['name'], '画像からのデッキ')
        self.assertEqual(deck['cards'], [{'id': 101, 'image_index': 1}, {'id': 101, 'image_index': 0}])
        self.assertEqual(deck['gachi'], [{'id': 209, 'image_index': 0}])
        self.assertEqual(deck['extra'], [{'id': 303, 'image_index': 0}])
        self.assertEqual(result['accepted_top1_count'], 2)
        self.assertEqual(server.read_saved_deck(output)['cards'], deck['cards'])
        restored = server.load_deck_config(deck)
        self.assertEqual([c['_image_index'] for c in restored['cards']], [1, 0])
        self.assertEqual(len(server.saved_deck_summaries()), 1)  # report must not become a fake saved deck
        report = json.loads(Path(result['report']).read_text(encoding='utf-8'))
        self.assertEqual(len(report['decisions']), 4)
        self.assertEqual(report['blocking_issues'], [])

    def test_skip_retains_only_resolved_entries(self):
        with patch.object(cli, 'analyze_image', return_value=result_fixture()):
            result = cli.convert_image(self.input, on_uncertain='skip')
        self.assertEqual(result['selected_count'], 2)
        self.assertEqual(result['skipped_count'], 2)
        self.assertEqual(result['section_counts'], {'cards': 1, 'extra': 0, 'gachi': 1, 'battle': 0})

    def test_strict_mode_reports_candidates_without_writing_deck(self):
        output = self.root / 'deck.json'
        report = self.root / 'analysis.json'
        with patch.object(cli, 'analyze_image', return_value=result_fixture()):
            self.assertEqual(cli.main([str(self.input), '-o', str(output), '--report', str(report), '--on-uncertain', 'error']), 3)
        self.assertFalse(output.exists())
        self.assertEqual(json.loads(report.read_text(encoding='utf-8'))['summary']['uncertain_count'], 2)

    def test_existing_output_and_report_collision_are_rejected_before_analysis(self):
        output = self.root / 'deck.json'
        output.write_text('keep me', encoding='utf-8')
        with patch.object(cli, 'analyze_image') as analyze:
            with self.assertRaises(FileExistsError):
                cli.convert_image(self.input, output)
            with self.assertRaises(ValueError):
                cli.convert_image(self.input, output, report_path=output, force=True)
            with self.assertRaises(ValueError):
                cli.convert_image(self.input, self.root/'new.json', report_path=server.DECK_DIRECTORY/'analysis.json')
            analyze.assert_not_called()
        self.assertEqual(output.read_text(encoding='utf-8'), 'keep me')
        with patch.object(cli, 'analyze_image', return_value=result_fixture()):
            cli.convert_image(self.input, output, force=True)
        self.assertEqual(json.loads(output.read_text(encoding='utf-8'))['version'], 4)

    def test_oversized_main_deck_is_not_truncated(self):
        analysis = {'cards': [dict(result_fixture()['cards'][0], position=i+1) for i in range(41)]}
        output = self.root / 'too-many.json'
        with patch.object(cli, 'analyze_image', return_value=analysis):
            with self.assertRaisesRegex(ValueError, '41枚'):
                cli.convert_image(self.input, output)
        self.assertFalse(output.exists())

    def test_missing_candidate_is_not_silently_dropped_by_best(self):
        analysis = {'cards': [{'position': 1, 'status': 'unknown', 'requires_review': True, 'candidates': []}]}
        output = self.root / 'missing.json'
        with patch.object(cli, 'analyze_image', return_value=analysis):
            with self.assertRaisesRegex(ValueError, '候補がない'):
                cli.convert_image(self.input, output)
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
