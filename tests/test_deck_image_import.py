import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import cv2
import numpy as np
import server
import deck_image_import as importer


def image(seed):
    rng = np.random.RandomState(seed)
    card = np.full((196, 140, 3), 12, dtype=np.uint8)
    card[5:-5, 5:-5] = rng.randint(65, 200, size=3)
    for _ in range(20):
        cv2.circle(card, tuple(int(n) for n in rng.randint([12, 12], [125, 180])),
                   int(rng.randint(5, 18)), tuple(int(n) for n in rng.randint(0, 255, size=3)), -1)
    return card


class ImageImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.images = self.root / '参照'
        self.images.mkdir()
        self.references = {name: image(seed) for name, seed in [('a0.png', 1), ('a1.png', 2), ('b.png', 3), ('unmapped.png', 4)]}
        for name, card in self.references.items():
            cv2.imencode('.png', card)[1].tofile(str(self.images / name))
        self.db = self.root / 'pDM.db'
        with sqlite3.connect(self.db) as db:
            db.execute('CREATE TABLE cardlist(cardname TEXT, imagefile TEXT, typetxt TEXT, packname TEXT)')
            db.execute('INSERT INTO cardlist(rowid,cardname,imagefile,typetxt,packname) VALUES(101,?,?,?,?)',
                       ('カードA', json.dumps(['a0.png', 'a1.png']), 'クリーチャー', ''))
            db.execute('INSERT INTO cardlist(rowid,cardname,imagefile,typetxt,packname) VALUES(209,?,?,?,?)',
                       ('カードB', json.dumps(['b.png']), 'GRクリーチャー', ''))
        db.close()
        self.patches = [patch.object(server, 'DATABASE_PATH', self.db), patch.object(server, 'IMAGE_ROOTS', (self.images,))]
        for item in self.patches:
            item.start()
        self.cards = [dict(server.card_view(server.get_card(id)), image_files=server.get_card(id)['image_files']) for id in [101, 209]]

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.temp.cleanup()

    def test_actual_dscan_maps_file_to_pdm_id_and_image_index(self):
        deck = np.full((260, 200, 3), 255, np.uint8)
        names = ['a1.png', 'b.png', 'a0.png', 'a1.png']
        for i, name in enumerate(names):
            x, y = 20 + (i % 2) * 80, 20 + (i // 2) * 110
            deck[y:y+98, x:x+70] = cv2.resize(self.references[name], (70, 98), interpolation=cv2.INTER_AREA)
        payload = cv2.imencode('.png', deck)[1].tobytes()
        result = importer.analyze_image(payload, self.cards, (self.images,), server.image_file_for, self.root/'cache')
        self.assertEqual(result['detected_count'], 4)
        self.assertEqual(result['reference_count'], 3)  # not the unrelated fourth file
        first = [c['candidates'][0] for c in result['cards']]
        self.assertEqual([(c['card']['id'], c['image_index']) for c in first], [(101, 1), (209, 0), (101, 0), (101, 1)])
        self.assertEqual(len(first[0]['card']['image_options']), 2)
        self.assertEqual(first[1]['card']['home_zone'], 'gachi')
        config = server.load_deck_config({'cards': [{'id': c['card']['id'], 'image_index': c['image_index']} for c in first]})
        self.assertEqual([c['_image_index'] for c in config['cards']], [1, 0, 1])
        self.assertEqual(len(config['gachi']), 1)
        self.assertTrue(all(c['crop_url'].startswith('data:image/png;base64,') for c in result['cards']))

    def test_grouping_preserves_variants_and_shared_image_records(self):
        lookup = {'first': [(101, 1), (209, 0)], 'second': [(101, 0)]}
        views = {c['id']: c for c in self.cards}
        ranked = [{'file': 'first', 'score': .95}, {'file': 'second', 'score': .94}]
        result = importer.mapped_candidates(ranked, lookup, views)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0]['card']['id'], 101)
        self.assertEqual(result[0]['image_index'], 1)
        self.assertEqual([v['image_index'] for v in result[0]['variants']], [1, 0])

    def test_broken_and_empty_image_and_concurrent_scan(self):
        for payload in [b'', b'not an image']:
            with self.assertRaises(importer.ScanError):
                importer.analyze_image(payload, self.cards, (self.images,), server.image_file_for, self.root/'cache')
        importer.SCAN_LOCK.acquire()
        try:
            with self.assertRaises(importer.ScanError) as caught:
                importer.analyze_image(b'x', self.cards, (self.images,), server.image_file_for, self.root/'cache')
            self.assertEqual(caught.exception.status, 429)
        finally:
            importer.SCAN_LOCK.release()

    def test_http_upload_rejects_oversized_and_cross_origin_before_reading(self):
        for headers, status in [({'Content-Length': str(importer.MAX_UPLOAD_BYTES + 1)}, 413),
                                ({'Content-Length': '100', 'Origin': 'https://elsewhere.example', 'Host': 'localhost:8765'}, 403)]:
            handler = object.__new__(server.SimulatorHandler)
            handler.headers = headers
            handler.rfile = io.BytesIO(b'do not consume this body')
            responses = []
            handler.send_json = lambda data, code=200: responses.append((data, code))
            handler.import_deck_image()
            self.assertEqual(handler.rfile.tell(), 0)
            self.assertEqual(responses[0][1], status)

    def test_http_upload_invokes_dscan_adapter_without_mutating_decks(self):
        handler = object.__new__(server.SimulatorHandler)
        handler.headers = {'Content-Length': '3'}
        handler.rfile = io.BytesIO(b'png')
        responses = []
        handler.send_json = lambda data, code=200: responses.append((data, code))
        with patch.object(server, 'analyze_image', return_value={'cards': [], 'detected_count': 0}) as analyze:
            handler.import_deck_image()
        self.assertEqual(analyze.call_args.args[0], b'png')
        self.assertEqual(analyze.call_args.args[1][0]['id'], 101)
        self.assertEqual(responses[0][1], 200)


if __name__ == '__main__':
    unittest.main()
