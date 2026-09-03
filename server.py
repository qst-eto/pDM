from __future__ import annotations

import json
import mimetypes
import random
import re
import sqlite3
import threading
import uuid
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


PROJECT_ROOT = Path(__file__).resolve().parents[1]
STATIC_ROOT = Path(__file__).resolve().parent / 'static'
# DBや画像を別の場所へ移す場合は、この設定欄だけを変更してください。
DATABASE_DIRECTORY = Path(r'C:\Users\andy2\Desktop\DM\projectDM\dm_data')
DATABASE_FILENAME = 'Duelmasters.db'
DATABASE_PATH = DATABASE_DIRECTORY / DATABASE_FILENAME

IMAGE_DIRECTORIES = (
    Path(r'C:\Users\andy2\Desktop\DM\projectDM\dm_data'),
)
IMAGE_ROOTS = IMAGE_DIRECTORIES
HOST = '0.0.0.0'
PORT = 8765
DECK_SIZE = 40
INITIAL_HAND_SIZE = 5
INITIAL_SHIELDS = 5

ZONES = ('deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss')
ZONE_LABELS = {
    'shields': 'シールドゾーン',
    'deck': '山札',
    'hand': '手札',
    'mana': 'マナ',
    'graveyard': '墓地',
    'battle': 'バトルゾーン',
    'extra': '超次元',
    'gachi': 'ガチャレンジ',
    'abyss': '深淵',
}

TABLES = {}
TABLES_LOCK = threading.Lock()


def db_connect():
    connection = sqlite3.connect(DATABASE_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def parse_image_files(value):
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except (TypeError, json.JSONDecodeError):
        parsed = [value]
    if isinstance(parsed, str):
        parsed = [parsed]
    image_files = []
    for item in parsed:
        if not item:
            continue
        normalized = str(item).strip().replace('\\', '/')
        path = Path(normalized)
        image_files.append(path.name if path.is_absolute() else normalized.lstrip('./'))
    return image_files


def image_candidates(image_root, filename):
    root = Path(image_root)
    relative = Path(str(filename).replace('/', '\\'))
    candidates = [root / relative]
    if relative.name != str(relative):
        candidates.append(root / relative.name)
    return candidates


def image_file_for(card):
    for filename in card.get('image_files', []):
        for image_root in IMAGE_ROOTS:
            root = Path(image_root)
            for image_path in image_candidates(root, filename):
                try:
                    image_path = image_path.resolve()
                    image_path.relative_to(root.resolve())
                except (OSError, ValueError):
                    continue
                if image_path.is_file():
                    return image_path
    return None


def card_from_row(row):
    card = dict(row)
    card['id'] = int(card.pop('id'))
    card['image_files'] = parse_image_files(card.get('imagefile'))
    card['image_url'] = '/api/cards/{}/image'.format(card['id'])
    return card


def enrich_mana_civils(card):
    """ツインパクトの場合は同じ画像を持つ上下両面の文明をまとめる。"""
    card_text = '{} {}'.format(card.get('cardname', ''), card.get('typetxt', ''))
    civils = [card.get('civiltxt', '')]
    is_twin = 'ツインパクト' in card_text or 'ツイン' in card_text
    if is_twin and card.get('image_files'):
        clauses = ' OR '.join('imagefile LIKE ?' for _ in card['image_files'])
        params = ['%{}%'.format(filename) for filename in card['image_files']]
        with db_connect() as connection:
            rows = connection.execute(
                'SELECT civiltxt FROM cardlist WHERE ({})'.format(clauses),
                params,
            ).fetchall()
        civils.extend(row['civiltxt'] for row in rows)
    card['mana_civils'] = ' '.join(value for value in civils if value)
    return card


def card_view(card):
    return {
        'id': card['id'],
        'cardname': card.get('cardname', ''),
        'packname': card.get('packname', ''),
        'typetxt': card.get('typetxt', ''),
        'civiltxt': card.get('civiltxt', ''),
        'mana_civils': card.get('mana_civils', card.get('civiltxt', '')),
        'costtxt': card.get('costtxt', ''),
        'powertxt': card.get('powertxt', ''),
        'manatxt': card.get('manatxt', ''),
        'racetxt': card.get('racetxt', ''),
        'abilitytxt': card.get('abilitytxt', ''),
        'flavortxt': card.get('flavortxt', ''),
        'image_url': card.get('image_url'),
    }


def get_card(card_id):
    with db_connect() as connection:
        row = connection.execute(
            'SELECT rowid AS id, * FROM cardlist WHERE rowid = ?',
            (card_id,),
        ).fetchone()
    return enrich_mana_civils(card_from_row(row)) if row else None


def get_cards(card_ids):
    cards = []
    for card_id in card_ids:
        try:
            card = get_card(int(card_id))
        except (TypeError, ValueError):
            card = None
        if card:
            cards.append(card)
    return cards


def fallback_deck():
    with db_connect() as connection:
        rows = connection.execute(
            'SELECT rowid AS id, * FROM cardlist ORDER BY rowid DESC LIMIT ?',
            (DECK_SIZE,),
        ).fetchall()
    return [enrich_mana_civils(card_from_row(row)) for row in rows]


def make_instance(card, face_up=True):
    return {
        'uid': uuid.uuid4().hex[:12],
        'card': card_view(card),
        'face_up': face_up,
        'tapped': False,
    }


def empty_player(name):
    return {
        'name': name,
        'zones': {zone: [] for zone in ZONES},
        'shields': [],
    }


def fill_deck(cards):
    if not cards:
        cards = fallback_deck()
    if not cards:
        return []
    result = list(cards)
    index = 0
    while len(result) < DECK_SIZE:
        result.append(cards[index % len(cards)])
        index += 1
    return result[:DECK_SIZE]


def new_table(player_name, deck_cards, opponent_cards):
    player_deck = fill_deck(deck_cards)
    opponent_deck = fill_deck(opponent_cards or fallback_deck())
    random.shuffle(player_deck)
    random.shuffle(opponent_deck)
    table = {
        'id': uuid.uuid4().hex[:10],
        'turn': 1,
        'active_player': 0,
        'players': [empty_player(player_name or 'プレイヤー'), empty_player('対戦相手')],
        'log': [],
    }
    for player, cards in zip(table['players'], (player_deck, opponent_deck)):
        player['zones']['deck'] = [make_instance(card, False) for card in cards]
        player['shields'] = [player['zones']['deck'].pop(0) for _ in range(
            min(INITIAL_SHIELDS, len(player['zones']['deck']))
        )]
        for _ in range(min(INITIAL_HAND_SIZE, len(player['zones']['deck']))):
            item = player['zones']['deck'].pop(0)
            item['face_up'] = True
            player['zones']['hand'].append(item)
    log_event(table, '手動対戦テーブルを作成しました。')
    return table


def log_event(table, message):
    table['log'].append(message)
    table['log'] = table['log'][-100:]


def locate_card(table, uid):
    for player_index, player in enumerate(table['players']):
        for zone in ZONES:
            for index, item in enumerate(player['zones'][zone]):
                if item['uid'] == uid:
                    return player_index, zone, index, item
        for index, item in enumerate(player['shields']):
            if item['uid'] == uid:
                return player_index, 'shields', index, item
    return None


def serialize_item(item, visible, force_reveal=False):
    if not force_reveal and (not visible or not item.get('face_up')):
        return {
            'uid': item['uid'],
            'face_up': False,
            'tapped': item.get('tapped', False),
            'card': None,
        }
    return {
        'uid': item['uid'],
        'face_up': True,
        'tapped': item.get('tapped', False),
        'card': item['card'],
    }


def public_player(player, player_index):
    zones = {}
    for zone in ZONES:
        visible = (
            (player_index == 0 and zone != 'deck')
            or (player_index == 1 and zone not in ('deck', 'hand', 'shields'))
        )
        zones[zone] = [
            serialize_item(
                item,
                visible,
                force_reveal=(player_index == 0 and zone == 'gachi' and index == 0),
            )
            for index, item in enumerate(player['zones'][zone])
        ]
    return {
        'name': player['name'],
        'zones': zones,
        # 裏向きシールドは隠し、表向きシールドは両プレイヤーへ公開する。
        'shields': [serialize_item(item, bool(item.get('face_up'))) for item in player['shields']],
        'counts': {zone: len(player['zones'][zone]) for zone in ZONES},
        'shield_count': len(player['shields']),
    }


def public_table(table):
    return {
        'id': table['id'],
        'turn': table['turn'],
        'active_player': table['active_player'],
        'players': [public_player(player, index) for index, player in enumerate(table['players'])],
        'log': table['log'],
    }


def move_cards(table, card_ids, target_zone, target_player=0, position='append'):
    if target_zone not in ZONES and target_zone != 'shields':
        return False, '移動先ゾーンが不正です。'
    if not isinstance(card_ids, list) or not card_ids:
        return False, 'カードが選択されていません。'
    if target_player not in (0, 1):
        return False, 'プレイヤー指定が不正です。'

    moving = []
    for uid in card_ids:
        located = locate_card(table, uid)
        if located and located[3] not in moving:
            moving.append(located[3])
    if not moving:
        return False, '対象カードが見つかりません。'

    for item in moving:
        located = locate_card(table, item['uid'])
        if located[1] == 'shields':
            table['players'][located[0]]['shields'].pop(located[2])
        else:
            table['players'][located[0]]['zones'][located[1]].pop(located[2])

    keep_face_down = bool(position == 'keep_face_down')
    if target_zone == 'shields':
        for item in moving:
            item['face_up'] = position == 'face_up'
            item['tapped'] = False
        table['players'][target_player]['shields'].extend(moving)
    elif target_zone in ('deck', 'gachi'):
        for item in moving:
            item['face_up'] = False
            item['tapped'] = False
        destination = table['players'][target_player]['zones'][target_zone]
        if target_zone == 'deck' and position == 'top':
            destination[0:0] = moving
        elif target_zone == 'deck' and position == 'bottom':
            destination.extend(moving)
        else:
            destination.extend(moving)
            if target_zone == 'deck':
                random.shuffle(destination)
    else:
        for item in moving:
            item['face_up'] = not keep_face_down
        table['players'][target_player]['zones'][target_zone].extend(moving)
    return True, ''


def apply_command(table, command, body):
    if command == 'draw':
        player_index = int(body.get('player', 0))
        count = max(1, min(int(body.get('count', 1)), 10))
        player = table['players'][player_index]
        drawn = 0
        for _ in range(count):
            if not player['zones']['deck']:
                break
            item = player['zones']['deck'].pop(0)
            item['face_up'] = True
            player['zones']['hand'].append(item)
            drawn += 1
        log_event(table, '{} が{}枚ドローしました。'.format(player['name'], drawn))
        return True, ''

    if command == 'view_deck':
        return True, ''

    if command == 'shuffle_deck':
        player_index = int(body.get('player', 0))
        random.shuffle(table['players'][player_index]['zones']['deck'])
        log_event(table, '{} の山札をシャッフルしました。'.format(table['players'][player_index]['name']))
        return True, ''

    if command == 'move':
        position = body.get('position', 'append')
        if body.get('keep_face_down') and body.get('zone') == 'mana':
            position = 'keep_face_down'
        ok, error = move_cards(
            table, body.get('card_ids', []), body.get('zone'),
            int(body.get('target_player', 0)), position,
        )
        if ok:
            log_event(table, 'カードを{}へ移動しました。'.format(ZONE_LABELS[body.get('zone')]))
        return ok, error

    if command in ('flip', 'tap'):
        value = bool(body.get('value'))
        changed = 0
        for uid in body.get('card_ids', []):
            located = locate_card(table, uid)
            if located:
                if command == 'flip':
                    located[3]['face_up'] = value
                else:
                    located[3]['tapped'] = value
                changed += 1
        return (True, '') if changed else (False, '対象カードが見つかりません。')

    if command == 'swap':
        first = locate_card(table, body.get('first'))
        second = locate_card(table, body.get('second'))
        if not first or not second or first[0:2] != second[0:2] or first[1] == 'shields':
            return False, '同じゾーンのカード同士だけ交換できます。'
        cards = table['players'][first[0]]['zones'][first[1]]
        cards[first[2]], cards[second[2]] = cards[second[2]], cards[first[2]]
        return True, ''

    return False, '不明なコマンドです。'


def deck_view(table, player_index=0, count=40):
    items = table['players'][player_index]['zones']['deck'][:max(1, min(count, 40))]
    return [
        {
            'uid': item['uid'],
            'face_up': True,
            'tapped': item.get('tapped', False),
            'card': item['card'],
        }
        for item in items
    ]


def parse_body(handler):
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        return json.loads(handler.rfile.read(length) or b'{}')
    except (ValueError, json.JSONDecodeError):
        return {}


class SimulatorHandler(BaseHTTPRequestHandler):
    server_version = 'DuelSimulator/0.3'

    def log_message(self, format_string, *args):
        return

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def send_file(self, path):
        data = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if path == '/api/meta':
            with db_connect() as connection:
                count = connection.execute('SELECT COUNT(*) FROM cardlist').fetchone()[0]
            self.send_json({'card_count': count, 'deck_size': DECK_SIZE, 'zones': ZONE_LABELS})
            return

        if path == '/api/cards':
            term = query.get('q', [''])[0].strip()
            civil = query.get('civil', [''])[0].strip()
            clauses, params = [], []
            if term:
                clauses.append('(cardname LIKE ? OR abilitytxt LIKE ? OR packname LIKE ?)')
                like = '%' + term + '%'
                params.extend([like, like, like])
            if civil:
                clauses.append('civiltxt LIKE ?')
                params.append('%' + civil + '%')
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            try:
                limit = min(max(int(query.get('limit', ['60'])[0]), 1), 100)
                offset = max(int(query.get('offset', ['0'])[0]), 0)
            except ValueError:
                limit, offset = 60, 0
            with db_connect() as connection:
                rows = connection.execute(
                    'SELECT rowid AS id, * FROM cardlist{} ORDER BY rowid DESC LIMIT ? OFFSET ?'.format(where),
                    params + [limit, offset],
                ).fetchall()
            self.send_json({'cards': [card_view(card_from_row(row)) for row in rows]})
            return

        card_match = re.fullmatch(r'/api/cards/(\d+)', path)
        if card_match:
            card = get_card(int(card_match.group(1)))
            if card:
                self.send_json(card_view(card))
            else:
                self.send_json({'error': 'カードが見つかりません。'}, HTTPStatus.NOT_FOUND)
            return

        image_match = re.fullmatch(r'/api/cards/(\d+)/image', path)
        if image_match:
            card = get_card(int(image_match.group(1)))
            if not card:
                self.send_json({'error': 'カードが見つかりません。'}, HTTPStatus.NOT_FOUND)
                return
            image_path = image_file_for(card)
            if image_path:
                self.send_file(image_path)
                return
            self.send_json({'error': '画像ファイルは未配置です。'}, HTTPStatus.NOT_FOUND)
            return

        table_match = re.fullmatch(r'/api/(?:tables|matches)/([a-z0-9]+)', path)
        if table_match:
            with TABLES_LOCK:
                table = TABLES.get(table_match.group(1))
            if not table:
                self.send_json({'error': '対戦テーブルが見つかりません。'}, HTTPStatus.NOT_FOUND)
                return
            self.send_json({'table': public_table(table)})
            return

        static_path = (STATIC_ROOT / ('index.html' if path == '/' else path.lstrip('/'))).resolve()
        static_root = STATIC_ROOT.resolve()
        try:
            static_path.relative_to(static_root)
            inside_root = True
        except ValueError:
            inside_root = False
        if inside_root and static_path.is_file():
            self.send_file(static_path)
            return
        self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        body = parse_body(self)

        if path in ('/api/tables', '/api/matches'):
            table = new_table(
                body.get('player_name', 'プレイヤー'),
                get_cards(body.get('deck', [])),
                get_cards(body.get('opponent_deck', [])),
            )
            with TABLES_LOCK:
                TABLES[table['id']] = table
            self.send_json({'table': public_table(table)}, HTTPStatus.CREATED)
            return

        command_match = re.fullmatch(r'/api/(?:tables|matches)/([a-z0-9]+)/(?:commands|actions)', path)
        if command_match:
            table_id = command_match.group(1)
            with TABLES_LOCK:
                table = TABLES.get(table_id)
                if not table:
                    self.send_json({'error': '対戦テーブルが見つかりません。'}, HTTPStatus.NOT_FOUND)
                    return
                command = body.get('command', body.get('action'))
                ok, error = apply_command(table, command, body)
                response = {'table': public_table(table)}
                if command == 'view_deck':
                    response['deck_view'] = deck_view(table, int(body.get('player', 0)), int(body.get('count', 40)))
                if not ok:
                    response['error'] = error
                    self.send_json(response, HTTPStatus.BAD_REQUEST)
                else:
                    self.send_json(response)
            return

        self.send_json({'error': 'エンドポイントが見つかりません。'}, HTTPStatus.NOT_FOUND)


def run():
    server = ThreadingHTTPServer((HOST, PORT), SimulatorHandler)
    print('Duel Simulator: http://127.0.0.1:{}'.format(PORT))
    print('LAN access: http://<このPCのIPアドレス>:{}'.format(PORT))
    print('終了するには Ctrl+C を押してください。')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    run()
