"""Dscan adapter. Map reference FILES to pDM IDs and image indices, never Dscan IDs.

Uploads/crops live only for the request. Only reference fingerprints are cached.
Optional numeric dependencies are loaded on first use so other pDM features work
even when the image-recognition environment has not been installed yet.
"""
import base64
import os
from pathlib import Path
import tempfile
import threading

MAX_UPLOAD_BYTES = 20 * 1024 * 1024
MAX_IMAGE_PIXELS = 24_000_000
MAX_CARDS = 200
SCAN_LOCK = threading.Lock()


class ScanError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def image_key(path):
    return os.path.normcase(str(Path(path).resolve()))


def reference_lookup(cards, locate_image):
    """One file can back multiple database records; one record can have many images."""
    lookup = {}
    views = {}
    for card in cards:
        available = []
        for index, filename in enumerate(card.get('image_files', [])):
            path = locate_image(card, index)
            if path is None:
                continue
            option = {'index': index, 'image_url': '/api/cards/{}/image?index={}'.format(card['id'], index)}
            available.append(option)
            lookup.setdefault(image_key(path), []).append((card['id'], index))
        view = {k: v for k, v in card.items() if k != 'image_files'}
        view['image_options'] = available
        views[card['id']] = view
    return lookup, views


def mapped_candidates(ranked, file_lookup, views, limit=5):
    """Group alternate printings under one pDM card, retaining each image index."""
    groups = {}
    for match in ranked:
        for card_id, image_index in file_lookup.get(match['file'], []):
            if card_id not in groups:
                groups[card_id] = {'card': views[card_id], 'score': match['score'],
                                   'image_index': image_index, 'variants': []}
            group = groups[card_id]
            if any(v['image_index'] == image_index for v in group['variants']):
                continue
            group['variants'].append({'image_index': image_index, 'score': match['score'],
                                      'image_url': '/api/cards/{}/image?index={}'.format(card_id, image_index)})
            if match['score'] > group['score']:
                group.update(score=match['score'], image_index=image_index)
    return sorted(groups.values(), key=lambda c: (-c['score'], c['card']['id']))[:limit]


def analyze_image(payload, cards, image_roots, locate_image, cache_directory):
    if not payload or len(payload) > MAX_UPLOAD_BYTES:
        raise ScanError('画像は20MB以下のファイルを選んでください。')
    if not SCAN_LOCK.acquire(blocking=False):
        raise ScanError('別の画像を解析中です。少し待ってから再実行してください。', 429)
    try:
        return _analyze_image(payload, cards, image_roots, locate_image, cache_directory)
    finally:
        SCAN_LOCK.release()


def _analyze_image(payload, cards, image_roots, locate_image, cache_directory):
    os.environ.setdefault('OPENCV_IO_MAX_IMAGE_PIXELS', str(MAX_IMAGE_PIXELS))
    try:
        import cv2
        import numpy as np
        from Dscan.deck_recognizer.images import read_image
        from Dscan.deck_recognizer.index import build_index, FEATURE_KEYS
        from Dscan.deck_recognizer.detection import detect
        from Dscan.deck_recognizer.matching import match_card
    except ImportError as error:
        raise ScanError('画像解析の準備が必要です。pDMで python -m pip install -r requirements.txt を実行し、サーバーを再起動してください。', 503) from error
    cv2.setNumThreads(1)
    try:
        with tempfile.TemporaryDirectory(prefix='pdm-scan-') as directory:
            upload = Path(directory) / 'upload.image'
            upload.write_bytes(payload)
            image = read_image(upload)
    except (ValueError, OSError, cv2.error) as error:
        raise ScanError('画像を読み込めませんでした。PNG・JPEG・WebPなどの画像ファイルを選んでください。') from error
    if image.shape[0] * image.shape[1] > MAX_IMAGE_PIXELS:
        raise ScanError('画像が大きすぎます。2400万画素以下に縮小してください。')
    boxes, detection = detect(image)
    if not boxes:
        raise ScanError('カードの領域が見つかりませんでした。デッキ一覧の部分を切り出した画像で再実行してください。')
    if len(boxes) > MAX_CARDS:
        raise ScanError('カードの領域が200個を超えました。デッキ一覧だけを切り出してください。')
    # Index existing files first. Many pDM database rows have no downloaded image;
    # probing the disk once per missing printing makes every web upload very slow.
    indexes, available_names = [], {}
    for root in image_roots:
        root = Path(root).resolve()
        if not root.is_dir():
            continue
        try:
            index = build_index(root, cache_directory)
        except ValueError:
            continue
        root_number = len(indexes)
        indexes.append((root, index))
        for entry in index['entries']:
            available_names[(root_number, os.path.normcase(entry['file']))] = root / entry['file']

    locations = {}

    def locate_existing(card, image_index):
        filename = card['image_files'][image_index].replace('\\', '/')
        if filename in locations:
            return locations[filename]
        for root_number in range(len(indexes)):
            for name in (filename, filename.rsplit('/', 1)[-1]):
                path = available_names.get((root_number, os.path.normcase(name)))
                if path is not None:
                    # Use the exact same resolution/containment rules as pDM's image API.
                    locations[filename] = locate_image(card, image_index)
                    return locations[filename]
        locations[filename] = None
        return None

    path_lookup, views = reference_lookup(cards, locate_existing)
    pieces = {key: [] for key in FEATURE_KEYS}
    entries, file_lookup, seen = [], {}, set()
    skipped = 0
    for root, index in indexes:
        skipped += len(index['skipped_files'])
        selected = []
        for number, entry in enumerate(index['entries']):
            key = image_key(root / entry['file'])
            if key not in path_lookup or key in seen:
                continue
            seen.add(key)
            # Unique keys avoid collisions between equally named files in different roots.
            token = str(len(entries))
            entries.append(dict(entry, file=token))
            file_lookup[token] = path_lookup[key]
            selected.append(number)
        if selected:
            for key in FEATURE_KEYS:
                pieces[key].append(index[key][selected])
    if not entries:
        raise ScanError('pDMのカードDBに対応する参照画像がありません。dm_dataの画像とDBのimagefile欄を確認してください。')
    combined = {key: np.concatenate(value, axis=0) for key, value in pieces.items()}
    combined['entries'] = entries
    results = []
    for position, (x, y, width, height) in enumerate(boxes, 1):
        crop = image[y:y+height, x:x+width]
        match = match_card(crop, combined, top_k=30, shortlist=50)
        candidates = mapped_candidates(match['candidates'], file_lookup, views)
        # Dscan's metadata may use a different DB, so ambiguity is checked again in pDM IDs.
        gap = candidates[0]['score'] - candidates[1]['score'] if len(candidates) > 1 else 1
        review = match['status'] != 'matched' or gap < .025
        reason = ('一致する画像が見つかりません。候補を確認するかカード名で検索してください。'
                  if match['status'] == 'unknown' else
                  'カードまたは使用する画像に複数の候補があります。' if review else '画像が一致しました。')
        preview = cv2.resize(crop, (120, 170), interpolation=cv2.INTER_AREA)
        _, encoded = cv2.imencode('.png', preview)
        results.append({'position': position, 'bbox': [x, y, width, height],
                        'crop_url': 'data:image/png;base64,' + base64.b64encode(encoded).decode('ascii'),
                        'status': match['status'], 'requires_review': review, 'reason': reason,
                        'candidates': candidates})
    return {'cards': results, 'detected_count': len(results),
            'review_count': sum(c['requires_review'] for c in results),
            'reference_count': len(entries), 'skipped_reference_count': skipped,
            'detection_method': detection['method'],
            'counting_note': '画像内のサムネイル1個を1枚として読み込みます。×4などの数字は読み取りません。'}
