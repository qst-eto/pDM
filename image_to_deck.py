#!/usr/bin/env python3
"""Convert an image directly to a pDM v4 deck JSON; no HTTP server is started."""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import sys
import uuid

import server
from deck_image_import import analyze_image, MAX_UPLOAD_BYTES


class ReviewRequired(ValueError):
    """Strict mode produced an analysis report but did not write/update a deck."""


def select_entries(analysis, name, policy='best'):
    """Preserve every occurrence and its printing; route GR/extra separately."""
    if policy not in ('best', 'skip', 'error'):
        raise ValueError('on_uncertain must be best, skip or error')
    deck = {'format': 'dm-table-forge-deck', 'version': 4, 'name': name,
            'cards': [], 'extra': [], 'gachi': [], 'battle': [],
            'allow_size_exceptions': False, 'saved_at': datetime.now(timezone.utc).isoformat()}
    decisions = []
    for row in analysis['cards']:
        candidates = row.get('candidates', [])
        uncertain = row.get('requires_review', False) or not candidates
        decision = {'position': row['position'], 'requires_review': uncertain,
                    'status': row.get('status'), 'selection': None}
        if uncertain and policy != 'best':
            decision['action'] = 'skipped' if policy == 'skip' else 'review_required'
        elif not candidates:
            decision['action'] = 'no_candidate'
        else:
            candidate = candidates[0]
            card = candidate['card']
            entry = {'id': int(card['id']), 'image_index': int(candidate['image_index'])}
            zone = card.get('home_zone') if card.get('home_zone') in ('extra', 'gachi') else 'cards'
            deck[zone].append(entry)
            decision.update(action='accepted_top1' if uncertain else 'matched',
                            selection=entry, section=zone, card_name=card.get('cardname', ''),
                            score=candidate.get('score'))
        decisions.append(decision)
    return deck, decisions


def write_json(path, payload, force=False):
    path.parent.mkdir(parents=True, exist_ok=True)
    # Exclusive creation protects existing decks, including races after preflight.
    with path.open('w' if force else 'x', encoding='utf-8', newline='\n') as stream:
        json.dump(payload, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


def convert_image(image_path, output_path=None, *, name=None, on_uncertain='best',
                  report_path=None, force=False):
    """Reusable Python entry point. Paths supplied by the caller are cwd-relative.

    Default output is pDM/saved_decks; analysis is kept OUTSIDE saved_decks so
    candidate records can never appear as a bogus deck in the web application's list.
    """
    image_path = Path(image_path).expanduser().resolve()
    if not image_path.is_file():
        raise ValueError('入力画像が見つかりません: {}'.format(image_path))
    if not 0 < image_path.stat().st_size <= MAX_UPLOAD_BYTES:
        raise ValueError('入力画像は20MB以下のファイルを指定してください。')
    if on_uncertain not in ('best', 'skip', 'error'):
        raise ValueError('on_uncertain must be best, skip or error')
    if not server.DATABASE_PATH.is_file():
        raise ValueError('pDMのカードDBが見つかりません: {}'.format(server.DATABASE_PATH))
    filename = 'deck-image-{}-{}.json'.format(datetime.now().strftime('%Y%m%d-%H%M%S'), uuid.uuid4().hex[:8])
    output = Path(output_path).expanduser().resolve() if output_path else (server.DECK_DIRECTORY / filename).resolve()
    report = Path(report_path).expanduser().resolve() if report_path else (
        server.PROJECT_ROOT / 'Dscan' / 'reports' / (output.stem + '.analysis.json')).resolve()
    if output.suffix.lower() != '.json' or report.suffix.lower() != '.json':
        raise ValueError('デッキと解析レポートの出力先には .json を指定してください。')
    if output.parent == server.DECK_DIRECTORY.resolve() and not re.fullmatch(r'[A-Za-z0-9_.-]+', output.name):
        raise ValueError('saved_decks内のファイル名には半角英数字・ハイフン・アンダースコアを使ってください。デッキ名は --name で日本語を指定できます。')
    if report == output or report == image_path or output == image_path:
        raise ValueError('入力画像、デッキJSON、解析レポートには別々のパスを指定してください。')
    if report == server.DECK_DIRECTORY.resolve() or server.DECK_DIRECTORY.resolve() in report.parents:
        raise ValueError('解析レポートはsaved_decksの外へ保存してください。')
    for path in (output, report):
        if path.exists() and not force:
            raise FileExistsError('出力先が既に存在します: {}。上書きする場合は --force を指定してください。'.format(path))
        if path.exists() and not path.is_file():
            raise ValueError('出力先がファイルではありません: {}'.format(path))
    with closing(server.db_connect()) as connection:
        rows = connection.execute('SELECT rowid AS id, * FROM cardlist ORDER BY rowid').fetchall()
    cards = []
    for row in rows:
        card = server.card_from_row(row)
        cards.append(dict(server.card_view(card), image_files=card['image_files']))
    print('画像を解析しています（初回は参照画像の索引を作成します）…', flush=True)
    analysis = analyze_image(image_path.read_bytes(), cards, server.IMAGE_ROOTS,
                             server.image_file_for, server.PROJECT_ROOT / 'Dscan' / 'cache')
    deck, decisions = select_entries(analysis, (name or '').strip() or image_path.stem, on_uncertain)
    issues = []
    if any(d['action'] == 'review_required' for d in decisions):
        issues.append('未確定の候補があります。--on-uncertain best で第1候補を採用するか、skipで未確定領域を除外できます。')
    if any(d['action'] == 'no_candidate' for d in decisions):
        issues.append('候補がない領域があります。--on-uncertain skipで除外できます。')
    if not any(deck[zone] for zone in ('cards', 'extra', 'gachi', 'battle')):
        issues.append('保存できるカードがありません。')
    if len(deck['cards']) > 40:
        issues.append('通常デッキが{}枚あります。40枚以内の画像を使用してください。カードは切り捨てません。'.format(len(deck['cards'])))
    if not issues:
        # Validate using the same code as pDM's normal save, without starting a server.
        validated = server.load_deck_config(deck)
        for zone in ('cards', 'extra', 'gachi', 'battle'):
            actual = [{'id': card['id'], 'image_index': int(card.get('_image_index', 0))} for card in validated[zone]]
            if actual != deck[zone]:
                issues.append('解析後にカード情報が変わりました。画像番号を保持するため、もう一度実行してください。')
                break
    summary = {'detected_count': len(analysis['cards']),
               'selected_count': sum(len(deck[z]) for z in ('cards', 'extra', 'gachi', 'battle')),
               'uncertain_count': sum(d['requires_review'] for d in decisions),
               'accepted_top1_count': sum(d['action'] == 'accepted_top1' for d in decisions),
               'skipped_count': sum(d['action'] == 'skipped' for d in decisions),
               'section_counts': {z: len(deck[z]) for z in ('cards', 'extra', 'gachi', 'battle')}}
    write_json(report, {'input': str(image_path), 'database': str(server.DATABASE_PATH.resolve()),
                        'requested_output': str(output), 'on_uncertain': on_uncertain,
                        'summary': summary, 'blocking_issues': issues, 'decisions': decisions,
                        'analysis': analysis}, force)
    if issues:
        error_type = ReviewRequired if on_uncertain == 'error' and summary['uncertain_count'] else ValueError
        raise error_type('{}\nデッキJSONは作成・更新していません。解析レポート: {}'.format('\n'.join(issues), report))
    write_json(output, deck, force)
    return {'output': str(output), 'report': str(report), **summary}


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, 'reconfigure'):
            stream.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser(description='画像ファイルからpDM用のデッキJSONを生成します（Webサーバー不要）。')
    parser.add_argument('image', help='入力するデッキ画像')
    parser.add_argument('-o', '--output', help='デッキJSONの保存先（省略時: pDM/saved_decks/）')
    parser.add_argument('--name', help='デッキ名（日本語可、省略時: 入力画像名）')
    parser.add_argument('--on-uncertain', choices=('best', 'skip', 'error'), default='best',
                        help='未確定候補の扱い: best=第1候補を採用（既定）、skip=除外、error=デッキを保存せず終了')
    parser.add_argument('--report', help='解析JSONの保存先（省略時: pDM/Dscan/reports/）')
    parser.add_argument('--force', action='store_true', help='既存のデッキJSON・解析レポートを上書き')
    args = parser.parse_args(argv)
    try:
        result = convert_image(args.image, args.output, name=args.name, on_uncertain=args.on_uncertain,
                               report_path=args.report, force=args.force)
    except ReviewRequired as error:
        print(str(error), file=sys.stderr)
        return 3
    except (ValueError, OSError) as error:
        print('ERROR: {}'.format(error), file=sys.stderr)
        return 2
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['accepted_top1_count']:
        print('注意: 未確定の{}領域は第1候補を採用しました。解析レポートで候補を確認できます。'.format(result['accepted_top1_count']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
