from __future__ import annotations

import json
import mimetypes
import random
import re
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from contextlib import closing
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse


PROJECT_ROOT = Path(__file__).resolve().parent
STATIC_ROOT = Path(__file__).resolve().parent / 'static'
# DBや画像を別の場所へ移す場合は、この設定欄だけを変更してください。
DATABASE_DIRECTORY = PROJECT_ROOT
DATABASE_FILENAME = 'Duelmasters.db'
DATABASE_PATH = DATABASE_DIRECTORY / DATABASE_FILENAME

IMAGE_DIRECTORIES = (
    PROJECT_ROOT / 'dm_data',
)
IMAGE_ROOTS = IMAGE_DIRECTORIES
DECK_DIRECTORY = Path(__file__).resolve().parent / 'saved_decks'
HOST = '0.0.0.0'
PORT = 8765
DECK_SIZE = 40
INITIAL_HAND_SIZE = 5
INITIAL_SHIELDS = 5
RANDOM_SOURCE = random.SystemRandom()

ZONES = ('deck', 'hand', 'mana', 'graveyard', 'waiting', 'battle', 'extra', 'gachi', 'abyss')
STACKABLE_ZONES = ('battle', 'shields')
ZONE_LABELS = {
    'shields': 'シールドゾーン',
    'deck': '山札',
    'hand': '手札',
    'mana': 'マナ',
    'graveyard': '墓地',
    'waiting': '待機ゾーン',
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


def image_file_for(card, image_index=0):
    files = card.get('image_files', [])
    try:
        image_index = int(image_index)
    except (TypeError, ValueError):
        image_index = 0
    filenames = files[image_index:image_index + 1] if 0 <= image_index < len(files) else files[:1]
    for filename in filenames:
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
        with closing(db_connect()) as connection:
            rows = connection.execute(
                'SELECT civiltxt FROM cardlist WHERE ({})'.format(clauses),
                params,
            ).fetchall()
        civils.extend(row['civiltxt'] for row in rows)
    card['mana_civils'] = ' '.join(value for value in civils if value)
    return card


def card_view(card):
    image_files = card.get('image_files', [])
    try:
        image_index = max(0, min(int(card.get('_image_index', 0)), max(0, len(image_files) - 1)))
    except (TypeError, ValueError):
        image_index = 0
    base_image_url = '/api/cards/{}/image'.format(card['id'])
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
        'image_url': '{}?index={}'.format(base_image_url, image_index) if image_files else card.get('image_url'),
        'image_index': image_index,
        'image_options': [
            {'index': index, 'image_url': '{}?index={}'.format(base_image_url, index)}
            for index in range(len(image_files))
        ],
        'home_zone': card_home_zone(card),
        'face_options': card.get('face_options', []),
        'face_actions': card.get('face_actions', {'up': [], 'down': []}),
    }


def card_home_zone(card):
    kind = card.get('typetxt') or ''
    if 'GRクリーチャー' in kind:
        return 'gachi'
    if 'サイキック' in kind:
        return 'extra'
    return None


def is_extra_face(card):
    return card_home_zone(card) == 'extra' and not any(char in (card.get('cardname') or '') for char in ('/', '／'))


def card_cost(card):
    match = re.search(r'\d+', str(card.get('costtxt') or ''))
    return int(match.group()) if match else None


def enrich_card_faces(card):
    card['face_options'] = []
    card['face_actions'] = {'up': [], 'down': []}
    if is_extra_face(card) and card.get('packname'):
        with closing(db_connect()) as connection:
            rows = connection.execute('SELECT rowid AS id, * FROM cardlist WHERE packname = ? ORDER BY rowid', (card['packname'],)).fetchall()
        candidates = [dict(row) for row in rows if row['id'] != card['id'] and is_extra_face(dict(row))]
        card['face_options'] = [{'id': row['id'], 'cardname': row['cardname'], 'costtxt': row.get('costtxt', '')} for row in candidates]
        if len(rows) >= 3 and card_cost(card) is not None:
            costs = sorted({card_cost(row) for row in [card, *candidates] if card_cost(row) is not None})
            current_cost = card_cost(card)
            lower = max((cost for cost in costs if cost < current_cost), default=None)
            upper = min((cost for cost in costs if cost > current_cost), default=None)
            if lower is not None:
                card['face_actions']['down'] = [
                    {'id': row['id'], 'cardname': row['cardname'], 'costtxt': row.get('costtxt', '')}
                    for row in candidates if card_cost(row) == lower
                ]
            if upper is not None:
                card['face_actions']['up'] = [
                    {'id': row['id'], 'cardname': row['cardname'], 'costtxt': row.get('costtxt', '')}
                    for row in candidates if card_cost(row) == upper
                ]
    return card


def get_card(card_id):
    with closing(db_connect()) as connection:
        row = connection.execute(
            'SELECT rowid AS id, * FROM cardlist WHERE rowid = ?',
            (card_id,),
        ).fetchone()
    return enrich_card_faces(enrich_mana_civils(card_from_row(row))) if row else None


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


def deck_file_path(deck_id):
    if not isinstance(deck_id, str) or not re.fullmatch(r'[A-Za-z0-9_.-]+', deck_id):
        return None
    path = (DECK_DIRECTORY / deck_id).resolve()
    try:
        path.relative_to(DECK_DIRECTORY.resolve())
    except ValueError:
        return None
    return path if path.suffix.lower() == '.json' else None


def read_saved_deck(path):
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
        cards = payload.get('cards') if isinstance(payload, dict) else None
        if not isinstance(cards, list):
            return None
        return {
            'id': path.name,
            'name': str(payload.get('name') or path.stem),
            'cards': cards[:DECK_SIZE],
            **{zone: payload.get(zone, []) if isinstance(payload.get(zone, []), list) else [] for zone in ('extra', 'gachi', 'battle')},
            'allow_size_exceptions': payload.get('allow_size_exceptions') is True,
            'saved_at': str(payload.get('saved_at') or ''),
        }
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def saved_deck_summaries():
    DECK_DIRECTORY.mkdir(parents=True, exist_ok=True)
    summaries = []
    for path in DECK_DIRECTORY.glob('*.json'):
        deck = read_saved_deck(path)
        if deck:
            summaries.append({
                'id': deck['id'],
                'name': deck['name'],
                'card_count': len(deck['cards']),
                'extra_count': len(deck['extra']),
                'gachi_count': len(deck['gachi']),
                'battle_count': len(deck['battle']),
                'saved_at': deck['saved_at'],
            })
    return sorted(summaries, key=lambda deck: (deck['saved_at'], deck['id']), reverse=True)


def fallback_deck():
    with closing(db_connect()) as connection:
        rows = connection.execute(
            'SELECT rowid AS id, * FROM cardlist ORDER BY rowid DESC',
        ).fetchall()
    normal = [row for row in rows if not card_home_zone(dict(row))][:DECK_SIZE]
    return [enrich_mana_civils(card_from_row(row)) for row in normal]


def make_instance(card, face_up=True):
    return {
        'uid': uuid.uuid4().hex[:12],
        'card': card_view(card),
        'face_up': True if card_home_zone(card) == 'extra' else face_up,
        'home_zone': card_home_zone(card),
        'tapped': False,
        'note': '',
        'shown_to_opponent': False,
        'stack': {'below': [], 'above': []},
    }


def empty_player(name):
    return {
        'name': name,
        'zones': {zone: [] for zone in ZONES},
        'shields': [],
        'hand_revealed_to_opponent': False,
        'hand_visible_to_spectators': False,
        'auto_draw_enabled': True,
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


def prepare_player(name, deck_cards, special_decks=None, deck_is_shuffled=False):
    """デッキ構成から、対戦開始時の1プレイヤー分の盤面を作る。"""
    cards = list(deck_cards) if deck_is_shuffled else fill_deck(deck_cards)
    if not deck_is_shuffled:
        RANDOM_SOURCE.shuffle(cards)
    player = empty_player(name or 'プレイヤー')
    player['zones']['deck'] = [make_instance(card, False) for card in cards]
    player['shields'] = [player['zones']['deck'].pop(0) for _ in range(
        min(INITIAL_SHIELDS, len(player['zones']['deck']))
    )]
    for _ in range(min(INITIAL_HAND_SIZE, len(player['zones']['deck']))):
        item = player['zones']['deck'].pop(0)
        item['face_up'] = True
        player['zones']['hand'].append(item)
    special = special_decks or {}
    gr_cards = list(special.get('gachi', []))
    RANDOM_SOURCE.shuffle(gr_cards)
    player['zones']['gachi'] = [make_instance(card, False) for card in gr_cards]
    player['zones']['extra'] = [make_instance(card) for card in special.get('extra', [])]
    player['zones']['battle'] = [make_instance(card) for card in special.get('battle', [])]
    return player


def load_deck_config(payload, main_key='cards', prefix='', for_start=False):
    sections = {}
    for section in ('cards', 'extra', 'gachi', 'battle'):
        raw = payload.get(prefix + (main_key if section == 'cards' else section), [])
        if not isinstance(raw, list) or len(raw) > (40 if section == 'cards' else 200):
            raise ValueError('デッキのカード一覧または枚数が不正です。')
        entries = []
        for entry in raw:
            try:
                card_id = int(entry.get('id') if isinstance(entry, dict) else entry)
                image_index = int(entry.get('image_index', 0)) if isinstance(entry, dict) else 0
                entries.append((card_id, max(0, image_index)))
            except (ValueError, TypeError):
                raise ValueError('カードIDが不正です。')
        sections[section] = get_cards([entry[0] for entry in entries])
        if len(sections[section]) != len(entries):
            raise ValueError('DBに存在しないカードが含まれています。')
        for card, (_, image_index) in zip(sections[section], entries):
            card['_image_index'] = min(image_index, max(0, len(card.get('image_files', [])) - 1))
    # 旧形式で通常デッキに入っていた特殊カードも山札へ混ぜない。
    main = []
    for card in sections['cards']:
        home = card_home_zone(card)
        if home:
            sections[home].append(card)
        else:
            main.append(card)
    sections['cards'] = main
    for zone in ('extra', 'gachi'):
        if any(card_home_zone(card) != zone for card in sections[zone]):
            raise ValueError('{}用ではないカードが含まれています。'.format(ZONE_LABELS[zone]))
    exceptions = payload.get(prefix + 'allow_size_exceptions') is True
    if for_start and not exceptions:
        extra_count = len(sections['extra']) + sum(card_home_zone(card) == 'extra' for card in sections['battle'])
        gr_count = len(sections['gachi']) + sum(card_home_zone(card) == 'gachi' for card in sections['battle'])
        if extra_count > 8:
            raise ValueError('超次元カードは8枚以下にしてください（開始時バトル分を含む）。')
        if gr_count not in (0, 12):
            raise ValueError('ガチャレンジを使う場合は12枚にしてください（開始時バトル分を含む）。')
    return sections


def new_table(player_name, deck_cards, opponent_cards, special_decks=None, opponent_special_decks=None):
    player_deck = fill_deck(deck_cards)
    opponent_deck = fill_deck(opponent_cards or fallback_deck())
    RANDOM_SOURCE.shuffle(player_deck)
    RANDOM_SOURCE.shuffle(opponent_deck)
    table = {
        'id': uuid.uuid4().hex[:10],
        'turn': 1,
        'active_player': 0,
        'players': [
            prepare_player(player_name or 'プレイヤー', player_deck, special_decks, deck_is_shuffled=True),
            prepare_player('対戦相手', opponent_deck, opponent_special_decks, deck_is_shuffled=True),
        ],
        'initial_setups': [
            {'name': player_name or 'プレイヤー', 'cards': list(player_deck), 'special': special_decks or {}},
            {'name': '対戦相手', 'cards': list(opponent_deck), 'special': opponent_special_decks or {}},
        ],
        'first_player': 0,
        'start_method': 'manual',
        'log': [],
        'game_log': [],
        'selections': [[], []],
    }
    log_event(table, '手動対戦テーブルを作成しました。')
    return table


def new_online_room(player_name, deck_cards, special_decks=None):
    table = {
        'id': '',
        'room_id': '',
        'mode': 'online',
        'status': 'waiting',
        'turn': 1,
        'active_player': 0,
        'players': [
            prepare_player(player_name or 'プレイヤー1', deck_cards, special_decks),
            empty_player('対戦相手を待っています'),
        ],
        'initial_setups': [
            {'name': player_name or 'プレイヤー1', 'cards': list(fill_deck(deck_cards)), 'special': special_decks or {}},
            None,
        ],
        'first_player': None,
        'start_method': 'coin',
        'player_tokens': [uuid.uuid4().hex, None],
        'spectator_tokens': [],
        'log': [],
        'game_log': [],
        'selections': [[], []],
    }
    log_event(table, '通信対戦の部屋を作成しました。対戦相手を待っています。')
    return table


def choose_first_player(table):
    """通信対戦の先攻を、公平にサーバー側のコイントスで決める。"""
    first = RANDOM_SOURCE.randrange(2)
    table['first_player'] = first
    table['active_player'] = first
    table['start_method'] = 'coin'
    message = 'コイントスの結果、{} が先攻です。'.format(table['players'][first]['name'])
    log_event(table, message)
    add_game_log(table, 'coin', {0: message, 1: message, 'spectator': message})
    return first


def restart_table(table):
    setups = table.get('initial_setups') or []
    if len(setups) != 2 or not all(setups):
        return False, '開始時のデッキ構成が見つかりません。'
    auto_draw = [player.get('auto_draw_enabled', True) for player in table['players']]
    table['players'] = [
        prepare_player(setup['name'], setup['cards'], setup.get('special'))
        for setup in setups
    ]
    for index, enabled in enumerate(auto_draw):
        table['players'][index]['auto_draw_enabled'] = enabled
    table['turn'] = 1
    table['log'] = []
    table['game_log'] = []
    table['selections'] = [[], []]
    if table.get('mode') == 'online':
        choose_first_player(table)
    else:
        table['first_player'] = 0
        table['active_player'] = 0
        log_event(table, '対戦を開始状態からやり直しました。')
    return True, ''


def log_event(table, message):
    table['log'].append(message)
    table['log'] = table['log'][-100:]


def add_game_log(table, kind, messages):
    """閲覧者ごとの安全な文面だけを保持する公開ログ。"""
    normalized = {str(key): str(value) for key, value in messages.items() if value}
    table.setdefault('game_log', []).append({
        'id': uuid.uuid4().hex[:12],
        'kind': kind,
        'turn': table.get('turn', 1),
        'messages': normalized,
    })
    table['game_log'] = table['game_log'][-200:]


def public_game_log(table, viewer_index=None, viewer_role='player'):
    key = 'spectator' if viewer_role == 'spectator' else str(viewer_index if viewer_index in (0, 1) else 0)
    return [
        {'id': entry['id'], 'kind': entry['kind'], 'turn': entry.get('turn', 1), 'message': entry['messages'][key]}
        for entry in table.get('game_log', [])
        if key in entry.get('messages', {})
    ]


def stack_parts(item):
    stack = item.get('stack')
    if not isinstance(stack, dict):
        stack = {'below': [], 'above': []}
        item['stack'] = stack
    for side in ('below', 'above'):
        if not isinstance(stack.get(side), list):
            stack[side] = []
    return stack


def count_stack_items(items):
    total = 0
    for item in items:
        stack = item.get('stack')
        total += 1
        if isinstance(stack, dict):
            total += count_stack_items(stack.get('below', []))
            total += count_stack_items(stack.get('above', []))
    return total


def iter_stack_items(items, player_index, zone, container=None):
    container = items if container is None else container
    for index, item in enumerate(items):
        yield player_index, zone, index, item, container
        stack = item.get('stack')
        if isinstance(stack, dict):
            for side in ('below', 'above'):
                children = stack.get(side, [])
                if isinstance(children, list):
                    yield from iter_stack_items(children, player_index, zone, children)


def locate_card(table, uid):
    for player_index, player in enumerate(table['players']):
        for zone in ZONES:
            for located in iter_stack_items(player['zones'][zone], player_index, zone):
                if located[3]['uid'] == uid:
                    return located
        for located in iter_stack_items(player['shields'], player_index, 'shields'):
            if located[3]['uid'] == uid:
                return located
    return None


def serialize_item(item, visible, force_reveal=False, owner_view=False, individual_hand_reveal=False):
    revealed = (
        force_reveal
        or (individual_hand_reveal and item.get('shown_to_opponent'))
        or (owner_view and item.get('private_to_opponent'))
        or (visible and item.get('face_up'))
    )
    result = {
        'uid': item['uid'],
        'face_up': bool(revealed),
        'tapped': item.get('tapped', False),
        'card': item['card'] if revealed else None,
        'home_zone': item.get('home_zone'),
        'private_to_opponent': bool(item.get('private_to_opponent')) if owner_view else False,
        'shown_to_opponent': bool(item.get('shown_to_opponent')) if owner_view else False,
        # 非公開カードのメモからカード内容を推測できないよう、カードと同じ公開範囲にする。
        'note': str(item.get('note') or '') if revealed else '',
    }
    stack = item.get('stack')
    if isinstance(stack, dict) and (stack.get('below') or stack.get('above')):
        result['stack'] = {
            'below': [serialize_item(child, visible, force_reveal, owner_view, individual_hand_reveal) for child in stack.get('below', [])],
            'above': [serialize_item(child, visible, force_reveal, owner_view, individual_hand_reveal) for child in stack.get('above', [])],
        }
    return result


def public_player(player, player_index, hand_visible=False, individual_hand_visible=False):
    zones = {}
    for zone in ZONES:
        visible = (
            (player_index == 0 and zone != 'deck')
            or (player_index != 0 and zone not in ('deck', 'hand', 'shields'))
        )
        if zone == 'hand' and player_index != 0:
            visible = bool(hand_visible)
        if zone == 'deck':
            # 通常の山札は非公開だが、表向きにした一番上のカードは公開する。
            visible = bool(player['zones'][zone][0].get('face_up')) if player['zones'][zone] else False
        zones[zone] = [
            serialize_item(
                item,
                visible,
                owner_view=player_index == 0,
                individual_hand_reveal=zone == 'hand' and individual_hand_visible,
            )
            for index, item in enumerate(player['zones'][zone])
        ]
    return {
        'name': player['name'],
        'zones': zones,
        # 裏向きシールドは隠し、表向きシールドは両プレイヤーへ公開する。
        'shields': [serialize_item(item, True) for item in player['shields']],
        'counts': {zone: count_stack_items(player['zones'][zone]) for zone in ZONES},
        'shield_count': count_stack_items(player['shields']),
        'hand_revealed_to_opponent': bool(player.get('hand_revealed_to_opponent')),
        'hand_visible_to_spectators': bool(player.get('hand_visible_to_spectators')),
        'auto_draw_enabled': bool(player.get('auto_draw_enabled', True)),
    }


def public_table(table, viewer_index=None, viewer_role='player'):
    online = table.get('mode') == 'online'
    if online and viewer_role == 'spectator':
        order = (0, 1)
        active_player = table['active_player']
        relations = ('spectator', 'spectator')
    elif online and viewer_index in (0, 1):
        order = (viewer_index, 1 - viewer_index)
        active_player = 0 if table['active_player'] == viewer_index else 1
        relations = ('self', 'opponent')
    else:
        order = (0, 1)
        active_player = table['active_player']
        relations = ('self', 'opponent')

    players = []
    for relative, internal in enumerate(order):
        player = table['players'][internal]
        relation = relations[relative]
        hand_visible = (
            player.get('hand_visible_to_spectators', False)
            if relation == 'spectator'
            else player.get('hand_revealed_to_opponent', False)
        )
        players.append(public_player(
            player,
            0 if relation == 'self' else 1,
            hand_visible,
            individual_hand_visible=relation == 'opponent',
        ))
    if online and viewer_role == 'spectator':
        remote_selected = [uid for selection in table.get('selections', [[], []]) for uid in selection]
    elif online and viewer_index in (0, 1):
        selections = table.get('selections', [[], []])
        remote_selected = list(selections[1 - viewer_index]) if len(selections) == 2 else []
    else:
        remote_selected = []
    return {
        'id': table['id'],
        'room_id': table.get('room_id', table['id']),
        'mode': table.get('mode', 'local'),
        'status': table.get('status', 'ready'),
        'viewer_role': viewer_role if online else 'local',
        'spectator_count': len(table.get('spectator_tokens', [])),
        'turn': table['turn'],
        'active_player': active_player,
        'first_player': (
            None if table.get('first_player') not in (0, 1)
            else order.index(table['first_player'])
        ),
        'start_method': table.get('start_method'),
        'start_message': (
            'コイントスの結果、{} が先攻です。'.format(table['players'][table['first_player']]['name'])
            if table.get('start_method') == 'coin' and table.get('first_player') in (0, 1) else ''
        ),
        # 閲覧者自身を常に player 0 として返し、両端末で手前側を自分にする。
        'players': players,
        'log': table['log'],
        'game_log': public_game_log(table, viewer_index, viewer_role),
        'remote_selected_card_ids': remote_selected,
    }


def online_player_index(table, token):
    if table.get('mode') != 'online' or not token:
        return None
    try:
        return table.get('player_tokens', []).index(token)
    except ValueError:
        return None


def online_viewer(table, token):
    player_index = online_player_index(table, token)
    if player_index in (0, 1):
        return {'role': 'player', 'player_index': player_index}
    if token and token in table.get('spectator_tokens', []):
        return {'role': 'spectator', 'player_index': None}
    return None


def leave_online_room(table, token):
    viewer = online_viewer(table, token)
    if not viewer:
        return False, False
    if viewer['role'] == 'spectator':
        table['spectator_tokens'].remove(token)
        return True, False

    leaving = viewer['player_index']
    other = 1 - leaving
    if not table.get('player_tokens', [None, None])[other]:
        return True, True
    if leaving == 0:
        table['players'][0] = table['players'][1]
        table['initial_setups'][0] = table['initial_setups'][1]
        table['player_tokens'][0] = table['player_tokens'][1]
    table['players'][1] = empty_player('対戦相手を待っています')
    table['initial_setups'][1] = None
    table['player_tokens'][1] = None
    table['status'] = 'waiting'
    table['turn'] = 1
    table['active_player'] = 0
    table['first_player'] = None
    table['game_log'] = []
    table['selections'] = [[], []]
    log_event(table, '対戦相手が退出したため待機状態に戻りました。')
    return True, False


def command_card_ids(command, body):
    if command in ('move', 'stack', 'flip', 'tap', 'turn_over', 'set_note', 'set_hand_card_visibility'):
        return list(body.get('card_ids', []))
    return []


def authorize_online_command(table, viewer_index, command, body):
    """通信対戦の相対 player 指定を内部番号へ直し、相手カードの操作を拒否する。"""
    if table.get('status') != 'ready' and command not in ('view_deck', 'set_hand_visibility', 'set_auto_draw', 'set_selection'):
        return None, '対戦相手が参加するまでカード操作はできません。'
    mapped = dict(body)
    if command == 'set_selection':
        mapped['selection_player'] = viewer_index
    if command == 'end_turn' and table.get('active_player') != viewer_index:
        return None, '自分のターンにだけターンを終了できます。'
    if command in ('draw', 'view_deck', 'shuffle_deck', 'set_hand_visibility', 'set_auto_draw'):
        try:
            relative_player = int(body.get('player', 0))
        except (TypeError, ValueError):
            return None, 'プレイヤー指定が不正です。'
        if relative_player != 0:
            return None, '通信対戦では相手の非公開ゾーンを操作できません。'
        mapped['player'] = viewer_index
    if command == 'move':
        try:
            target_player = int(body.get('target_player', 0))
        except (TypeError, ValueError):
            return None, 'プレイヤー指定が不正です。'
        if target_player != 0:
            return None, '通信対戦では相手のゾーンへカードを移動できません。'
        mapped['target_player'] = viewer_index
    for uid in command_card_ids(command, body):
        located = locate_card(table, uid)
        if not located or located[0] != viewer_index:
            return None, '通信対戦では相手のカードを操作できません。'
    if command == 'stack':
        target = locate_card(table, body.get('target_id'))
        if not target or target[0] != viewer_index:
            return None, '通信対戦では相手のカードを操作できません。'
    return mapped, ''


def move_cards(table, card_ids, target_zone, target_player=0, position='append', preserve_stack=False):
    if target_zone not in ZONES and target_zone != 'shields':
        return False, '移動先ゾーンが不正です。'
    if not isinstance(card_ids, list) or not card_ids:
        return False, 'カードが選択されていません。'
    if target_player not in (0, 1):
        return False, 'プレイヤー指定が不正です。'

    moving = selected_items(table, card_ids)
    if not moving:
        return False, '対象カードが見つかりません。'

    if not all(can_move_item(item, target_zone) for item in moving):
        return False, '超次元・ガチャレンジのカードは元のゾーン、バトルゾーン、深淵ゾーンにだけ移動できます。'

    for item in moving:
        if not detach_item(table, item):
            return False, '対象カードが見つかりません。'

    if not preserve_stack or target_zone not in STACKABLE_ZONES:
        moving = list(flattened_stack_items(moving))

    keep_face_down = bool(position == 'keep_face_down')
    all_moving = [part for item in moving for part in [item, *stack_descendants(item)]]
    for item in all_moving:
        item['private_to_opponent'] = bool(target_zone == 'waiting' and keep_face_down)
        item['shown_to_opponent'] = False
    if target_zone == 'shields':
        for item in all_moving:
            item['face_up'] = position == 'face_up'
            item['tapped'] = False
        table['players'][target_player]['shields'].extend(moving)
    elif target_zone in ('deck', 'gachi'):
        for item in all_moving:
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
                RANDOM_SOURCE.shuffle(destination)
    else:
        for item in all_moving:
            item['face_up'] = not keep_face_down
        table['players'][target_player]['zones'][target_zone].extend(moving)
    return True, ''


def stack_cards(table, card_ids, target_uid, position='above', allow_any_zone=False):
    if not isinstance(card_ids, list) or not card_ids:
        return False, '重ねるカードが選択されていません。'
    if position not in ('below', 'above'):
        return False, '重ねる位置が不正です。'

    target_location = locate_card(table, target_uid)
    if not target_location:
        return False, '重ねる対象のカードが見つかりません。'
    if target_location[1] not in STACKABLE_ZONES:
        return False, '重ねる対象はバトルゾーンまたはシールドゾーンのカードだけです。'
    target = target_location[3]
    moving = []
    for item in selected_items(table, card_ids):
        located = locate_card(table, item['uid'])
        if not located:
            continue
        if located[0] != target_location[0]:
            return False, '同じプレイヤーのカード同士だけ重ねられます。'
        if item is target or item in moving:
            continue
        # 対象カード自身を含む重なり全体を、その中へ重ねることは禁止する。
        if any(child is target for child in stack_descendants(item)):
            return False, '重なりの中にあるカードへは重ねられません。'
        moving.append(item)
    if not moving:
        return False, '重ねるカードが見つかりません。'
    if not all(can_move_item(item, target_location[1]) for item in moving):
        return False, '超次元・ガチャレンジのカードはシールドゾーンに重ねられません。'

    for item in moving:
        if not detach_item(table, item):
            return False, '重ねるカードが見つかりません。'
        # 重ねる前の表裏・タップ状態をそのまま引き継ぐ。
    stack = stack_parts(target)
    stack[position].extend(moving)
    return True, ''


def stack_descendants(item):
    stack = item.get('stack')
    if not isinstance(stack, dict):
        return
    for side in ('below', 'above'):
        for child in stack.get(side, []):
            yield child
            yield from stack_descendants(child)


def top_stack_item(item):
    stack = stack_parts(item)
    return top_stack_item(stack['above'][-1]) if stack['above'] else item


def can_move_item(item, zone):
    return all(not part.get('home_zone') or zone in (part['home_zone'], 'battle', 'abyss')
               for part in [item, *stack_descendants(item)])


def selected_items(table, card_ids):
    """選択された親カードと、その内部カードの二重指定を整理する。"""
    if not isinstance(card_ids, list):
        return []
    candidates = []
    for uid in card_ids:
        located = locate_card(table, uid)
        if located and located[3] not in candidates:
            candidates.append(located[3])
    return [
        item for item in candidates
        if not any(item is not other and any(child is item for child in stack_descendants(other))
                   for other in candidates)
    ]


def detach_item(table, item):
    located = locate_card(table, item['uid'])
    if not located:
        return False
    located[4].pop(located[2])
    return True


def flattened_stack_items(items):
    """重なりを解除し、下側から上側の順で個別カードに展開する。"""
    for item in items:
        stack = item.get('stack')
        if isinstance(stack, dict):
            yield from flattened_stack_items(stack.get('below', []))
        item['stack'] = {'below': [], 'above': []}
        yield item
        if isinstance(stack, dict):
            yield from flattened_stack_items(stack.get('above', []))


def card_identity_visible(table, owner_index, zone, item, audience):
    """現在の盤面で、対象の閲覧者がカード名を知れるかを判定する。"""
    face_up = bool(item.get('face_up'))
    player = table['players'][owner_index]
    if audience in (0, 1) and audience == owner_index:
        if zone == 'deck':
            deck = player['zones']['deck']
            return face_up and bool(deck) and deck[0] is item
        if zone == 'waiting' and item.get('private_to_opponent'):
            return True
        return face_up
    if zone == 'deck':
        deck = player['zones']['deck']
        return face_up and bool(deck) and deck[0] is item
    if zone == 'hand':
        if audience == 'spectator':
            return face_up and bool(player.get('hand_visible_to_spectators'))
        return face_up and bool(player.get('hand_revealed_to_opponent') or item.get('shown_to_opponent'))
    if zone == 'shields':
        return face_up
    if zone == 'waiting' and item.get('private_to_opponent'):
        return False
    return face_up


def capture_movement(table, card_ids):
    records = []
    seen = set()
    for root in selected_items(table, card_ids):
        for item in [root, *stack_descendants(root)]:
            if item['uid'] in seen:
                continue
            seen.add(item['uid'])
            located = locate_card(table, item['uid'])
            if not located:
                continue
            owner_index, zone = located[0], located[1]
            records.append({
                'uid': item['uid'],
                'item': item,
                'name': str(item.get('card', {}).get('cardname') or '名称不明のカード'),
                'source_zone': zone,
                'known_before': {
                    audience: card_identity_visible(table, owner_index, zone, item, audience)
                    for audience in (0, 1, 'spectator')
                },
            })
    return records


def log_movement(table, records):
    for record in records:
        located = locate_card(table, record['uid'])
        if not located:
            continue
        owner_index, target_zone, item = located[0], located[1], located[3]
        messages = {}
        for audience in (0, 1, 'spectator'):
            known = record['known_before'].get(audience, False) or card_identity_visible(
                table, owner_index, target_zone, item, audience,
            )
            name = '「{}」'.format(record['name']) if known else '非公開カード'
            messages[audience] = '{}：{} → {}'.format(
                name, ZONE_LABELS.get(record['source_zone'], record['source_zone']),
                ZONE_LABELS.get(target_zone, target_zone),
            )
        add_game_log(table, 'move', messages)


def prune_selections(table):
    existing = set()
    for player_index, player in enumerate(table['players']):
        for zone in ZONES:
            existing.update(item['uid'] for _, _, _, item, _ in iter_stack_items(player['zones'][zone], player_index, zone))
        existing.update(item['uid'] for _, _, _, item, _ in iter_stack_items(player['shields'], player_index, 'shields'))
    selections = table.setdefault('selections', [[], []])
    while len(selections) < 2:
        selections.append([])
    for index in (0, 1):
        selections[index] = [uid for uid in selections[index] if uid in existing]


def draw_cards(table, player_index, count=1):
    drawn = 0
    player = table['players'][player_index]
    for _ in range(max(0, count)):
        if not player['zones']['deck']:
            break
        uid = player['zones']['deck'][0]['uid']
        movement = capture_movement(table, [uid])
        ok, _ = move_cards(table, [uid], 'hand', player_index)
        if not ok:
            break
        log_movement(table, movement)
        drawn += 1
    prune_selections(table)
    return drawn


def apply_command(table, command, body):
    if command == 'set_selection':
        try:
            player_index = int(body.get('selection_player', 0))
        except (TypeError, ValueError):
            return False, 'プレイヤー指定が不正です。'
        card_ids = body.get('card_ids', [])
        if player_index not in (0, 1) or not isinstance(card_ids, list) or len(card_ids) > 100:
            return False, '選択情報が不正です。'
        normalized = []
        for uid in card_ids:
            uid = str(uid)
            if not locate_card(table, uid):
                return False, '選択したカードが見つかりません。'
            if uid not in normalized:
                normalized.append(uid)
        selections = table.setdefault('selections', [[], []])
        while len(selections) < 2:
            selections.append([])
        selections[player_index] = normalized
        return True, ''

    if command == 'set_auto_draw':
        try:
            player_index = int(body.get('player', 0))
        except (TypeError, ValueError):
            return False, 'プレイヤー指定が不正です。'
        if player_index not in (0, 1):
            return False, 'プレイヤー指定が不正です。'
        table['players'][player_index]['auto_draw_enabled'] = bool(body.get('value', True))
        return True, ''

    if command == 'set_hand_visibility':
        try:
            player_index = int(body.get('player', 0))
        except (TypeError, ValueError):
            return False, 'プレイヤー指定が不正です。'
        if player_index not in (0, 1):
            return False, 'プレイヤー指定が不正です。'
        audience = body.get('audience')
        key = {
            'opponent': 'hand_revealed_to_opponent',
            'spectators': 'hand_visible_to_spectators',
        }.get(audience)
        if not key:
            return False, '手札の公開先が不正です。'
        value = bool(body.get('value'))
        player = table['players'][player_index]
        player[key] = value
        label = '対戦相手' if audience == 'opponent' else '観戦者'
        log_event(table, '{} が手札を{}へ{}にしました。'.format(player['name'], label, '公開' if value else '非公開'))
        return True, ''

    if command == 'set_hand_card_visibility':
        items = selected_items(table, body.get('card_ids', []))
        if not items:
            return False, '相手に見せる手札を選択してください。'
        for item in items:
            located = locate_card(table, item['uid'])
            if not located or located[1] != 'hand':
                return False, '手札のカードだけ相手に見せられます。'
        value = bool(body.get('value', True))
        for item in items:
            for card in [item, *stack_descendants(item)]:
                card['shown_to_opponent'] = value
        player_name = table['players'][locate_card(table, items[0]['uid'])[0]]['name']
        log_event(table, '{} が手札{}枚を相手に{}。'.format(
            player_name, count_stack_items(items), '見せました' if value else '隠しました',
        ))
        return True, ''

    if command == 'set_note':
        items = selected_items(table, body.get('card_ids', []))
        if not items:
            return False, 'メモを付けるカードを選択してください。'
        note = str(body.get('note') or '').strip()
        if len(note) > 120:
            return False, 'メモは120文字以内にしてください。'
        for item in items:
            top_stack_item(item)['note'] = note
        log_event(table, '{}枚のカードのメモを{}しました。'.format(len(items), '更新' if note else '削除'))
        return True, ''

    if command == 'end_turn':
        table['active_player'] = 1 - table['active_player']
        if table['active_player'] == table.get('first_player', 0):
            table['turn'] += 1
        log_event(table, '{} のターンになりました。'.format(table['players'][table['active_player']]['name']))
        if table['players'][table['active_player']].get('auto_draw_enabled', True):
            draw_cards(table, table['active_player'], 1)
        return True, ''

    if command == 'draw':
        player_index = int(body.get('player', 0))
        count = max(1, min(int(body.get('count', 1)), 10))
        drawn = draw_cards(table, player_index, count)
        log_event(table, '{} が{}枚ドローしました。'.format(table['players'][player_index]['name'], drawn))
        return True, ''

    if command == 'view_deck':
        return True, ''

    if command == 'shuffle_deck':
        player_index = int(body.get('player', 0))
        RANDOM_SOURCE.shuffle(table['players'][player_index]['zones']['deck'])
        log_event(table, '{} の山札をシャッフルしました。'.format(table['players'][player_index]['name']))
        return True, ''

    if command == 'restart_game':
        return restart_table(table)

    if command == 'move':
        movement = capture_movement(table, body.get('card_ids', []))
        position = body.get('position', 'append')
        if body.get('keep_face_down') and body.get('zone') in ('mana', 'waiting'):
            position = 'keep_face_down'
        ok, error = move_cards(
            table, body.get('card_ids', []), body.get('zone'),
            int(body.get('target_player', 0)), position, bool(body.get('preserve_stack')),
        )
        if ok:
            log_event(table, 'カードを{}へ移動しました。'.format(ZONE_LABELS[body.get('zone')]))
            log_movement(table, movement)
            prune_selections(table)
        return ok, error

    if command == 'stack':
        movement = capture_movement(table, body.get('card_ids', []))
        ok, error = stack_cards(
            table,
            body.get('card_ids', []),
            body.get('target_id'),
            body.get('position', 'above'),
        )
        if ok:
            log_event(table, 'カードを別のカードに重ねました。')
            log_movement(table, movement)
            prune_selections(table)
        return ok, error

    if command in ('flip', 'tap'):
        value = bool(body.get('value'))
        if command == 'flip' and not value and any(
            located and located[3].get('home_zone') == 'extra'
            for located in (locate_card(table, uid) for uid in body.get('card_ids', []))
        ):
            return False, '超次元カードの面は「裏返す」で切り替えてください。'
        changed = 0
        for uid in body.get('card_ids', []):
            located = locate_card(table, uid)
            if located:
                if command == 'flip':
                    located[3]['face_up'] = value
                    if value:
                        located[3]['private_to_opponent'] = False
                else:
                    located[3]['tapped'] = value
                changed += 1
        return (True, '') if changed else (False, '対象カードが見つかりません。')

    if command == 'turn_over':
        items = selected_items(table, body.get('card_ids', []))
        if len(items) != 1 or items[0].get('home_zone') != 'extra':
            return False, '裏返す超次元カードを1枚選択してください。'
        item = items[0]
        current = get_card(item['card']['id'])
        options = current.get('face_options', []) if current else []
        actions = current.get('face_actions', {'up': [], 'down': []}) if current else {'up': [], 'down': []}
        allowed = [option['id'] for option in options]
        action_ids = [option['id'] for direction in actions.values() for option in direction]
        if action_ids:
            allowed = action_ids
        default_target = options[0]['id'] if len(options) == 1 and not any(actions.values()) else None
        target_id = body.get('face_id', default_target)
        if target_id not in allowed:
            return False, '切り替える面を選択してください。'
        other = get_card(target_id)
        if not other:
            return False, '切り替える面がDBにありません。'
        item['card'] = card_view(other)
        item['face_up'] = True
        log_event(table, '超次元カードを裏返しました。')
        return True, ''

    return False, '不明なコマンドです。'


def deck_view(table, player_index=0, count=40):
    items = table['players'][player_index]['zones']['deck'][:max(1, min(count, 40))]
    return [serialize_item(item, True, force_reveal=True) for item in items]


def parse_body(handler):
    try:
        length = int(handler.headers.get('Content-Length', '0'))
        return json.loads(handler.rfile.read(length) or b'{}')
    except (ValueError, json.JSONDecodeError):
        return {}


class SimulatorHandler(BaseHTTPRequestHandler):
    server_version = 'DuelSimulator/0.3'

    @staticmethod
    def _client_disconnected(error):
        return isinstance(error, (BrokenPipeError, ConnectionResetError, ConnectionAbortedError))

    def log_message(self, format_string, *args):
        return

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
        try:
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(data)
        except OSError as error:
            if not self._client_disconnected(error):
                raise

    def send_file(self, path):
        data = path.read_bytes()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header('Content-Type', mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
            self.send_header('Content-Length', str(len(data)))
            self.send_header('Cache-Control', 'no-cache')
            self.end_headers()
            self.wfile.write(data)
        except OSError as error:
            if not self._client_disconnected(error):
                raise

    def player_token(self, query=None):
        query = query or {}
        token = query.get('player_token', [''])[0]
        if token:
            return token
        authorization = self.headers.get('Authorization', '')
        if authorization.startswith('Bearer '):
            return authorization[7:].strip()
        return self.headers.get('X-Player-Token', '').strip()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        query = parse_qs(parsed.query)

        if path == '/api/meta':
            with closing(db_connect()) as connection:
                count = connection.execute('SELECT COUNT(*) FROM cardlist').fetchone()[0]
            self.send_json({'card_count': count, 'deck_size': DECK_SIZE, 'zones': ZONE_LABELS})
            return

        if path == '/api/decks':
            self.send_json({'decks': saved_deck_summaries()})
            return

        saved_deck_match = re.fullmatch(r'/api/decks/([A-Za-z0-9_.-]+)', path)
        if saved_deck_match:
            deck_path = deck_file_path(saved_deck_match.group(1))
            deck = read_saved_deck(deck_path) if deck_path and deck_path.is_file() else None
            if deck:
                self.send_json({'deck': deck})
            else:
                self.send_json({'error': '保存されたデッキが見つかりません。'}, HTTPStatus.NOT_FOUND)
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
            section = query.get('section', [''])[0]
            extra_clause = "typetxt LIKE '%サイキック%'"
            gr_clause = "typetxt LIKE '%GRクリーチャー%'"
            if section == 'extra':
                clauses.append(extra_clause)
            elif section == 'gachi':
                clauses.append(gr_clause)
            elif section == 'deck':
                clauses.append('NOT ({} OR {})'.format(extra_clause, gr_clause))
            where = ' WHERE ' + ' AND '.join(clauses) if clauses else ''
            try:
                limit = min(max(int(query.get('limit', ['60'])[0]), 1), 100)
                offset = max(int(query.get('offset', ['0'])[0]), 0)
            except ValueError:
                limit, offset = 60, 0
            with closing(db_connect()) as connection:
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
            image_path = image_file_for(card, query.get('index', ['0'])[0])
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
                viewer_index = None
                viewer_role = 'player'
                if table.get('mode') == 'online':
                    viewer = online_viewer(table, self.player_token(query))
                    if viewer is None:
                        self.send_json({'error': 'この部屋への接続情報を確認できません。'}, HTTPStatus.FORBIDDEN)
                        return
                    viewer_index = viewer['player_index']
                    viewer_role = viewer['role']
                response = {'table': public_table(table, viewer_index, viewer_role)}
            self.send_json(response)
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

        if path == '/api/rooms':
            try:
                own = load_deck_config(body, main_key='deck', for_start=True)
            except ValueError as error:
                self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
                return
            table = new_online_room(body.get('player_name', 'プレイヤー1'), own['cards'], own)
            with TABLES_LOCK:
                for _ in range(100):
                    room_id = '{:06d}'.format(RANDOM_SOURCE.randrange(100000, 1000000))
                    if room_id not in TABLES:
                        break
                else:
                    self.send_json({'error': '部屋番号を発行できませんでした。'}, HTTPStatus.SERVICE_UNAVAILABLE)
                    return
                table['id'] = room_id
                table['room_id'] = room_id
                TABLES[room_id] = table
                response = {
                    'table': public_table(table, 0),
                    'room_id': room_id,
                    'player_token': table['player_tokens'][0],
                }
            self.send_json(response, HTTPStatus.CREATED)
            return

        room_leave_match = re.fullmatch(r'/api/rooms/(\d{6})/leave', path)
        if room_leave_match:
            room_id = room_leave_match.group(1)
            token = self.player_token(parse_qs(parsed.query)) or str(body.get('player_token') or '')
            with TABLES_LOCK:
                table = TABLES.get(room_id)
                if not table or table.get('mode') != 'online':
                    self.send_json({'left': True, 'room_closed': True})
                    return
                left, close_room = leave_online_room(table, token)
                if not left:
                    self.send_json({'error': 'この部屋への接続情報を確認できません。'}, HTTPStatus.FORBIDDEN)
                    return
                if close_room:
                    TABLES.pop(room_id, None)
            self.send_json({'left': True, 'room_closed': close_room})
            return

        room_join_match = re.fullmatch(r'/api/rooms/(\d{6})/join', path)
        if room_join_match:
            room_id = room_join_match.group(1)
            with TABLES_LOCK:
                table = TABLES.get(room_id)
                if not table or table.get('mode') != 'online':
                    self.send_json({'error': '部屋番号が見つかりません。'}, HTTPStatus.NOT_FOUND)
                    return
                if table.get('status') == 'ready':
                    spectator_token = uuid.uuid4().hex
                    table.setdefault('spectator_tokens', []).append(spectator_token)
                    response = {
                        'table': public_table(table, None, 'spectator'),
                        'room_id': room_id,
                        'player_token': spectator_token,
                        'viewer_role': 'spectator',
                    }
                    self.send_json(response)
                    return
            try:
                own = load_deck_config(body, main_key='deck', for_start=True)
            except ValueError as error:
                self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
                return
            new_player = prepare_player(body.get('player_name', 'プレイヤー2'), own['cards'], own)
            with TABLES_LOCK:
                table = TABLES.get(room_id)
                if not table or table.get('mode') != 'online':
                    self.send_json({'error': '部屋番号が見つかりません。'}, HTTPStatus.NOT_FOUND)
                    return
                if table.get('status') == 'ready':
                    spectator_token = uuid.uuid4().hex
                    table.setdefault('spectator_tokens', []).append(spectator_token)
                    response = {
                        'table': public_table(table, None, 'spectator'),
                        'room_id': room_id,
                        'player_token': spectator_token,
                        'viewer_role': 'spectator',
                    }
                else:
                    host_setup = table['initial_setups'][0]
                    host_auto_draw = table['players'][0].get('auto_draw_enabled', True)
                    table['players'][0] = prepare_player(
                        host_setup['name'], host_setup['cards'], host_setup.get('special'),
                    )
                    table['players'][0]['auto_draw_enabled'] = host_auto_draw
                    table['players'][1] = new_player
                    table['initial_setups'][1] = {
                        'name': body.get('player_name', 'プレイヤー2'),
                        'cards': list(fill_deck(own['cards'])),
                        'special': own,
                    }
                    table['player_tokens'][1] = uuid.uuid4().hex
                    table['status'] = 'ready'
                    table['game_log'] = []
                    table['selections'] = [[], []]
                    log_event(table, '{} が参加しました。対戦を開始できます。'.format(table['players'][1]['name']))
                    choose_first_player(table)
                    response = {
                        'table': public_table(table, 1),
                        'room_id': room_id,
                        'player_token': table['player_tokens'][1],
                        'viewer_role': 'player',
                    }
            self.send_json(response)
            return

        if path in ('/api/tables', '/api/matches'):
            try:
                own = load_deck_config(body, main_key='deck', for_start=True)
                opponent = load_deck_config(body, main_key='deck', prefix='opponent_', for_start=True)
            except ValueError as error:
                self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
                return
            table = new_table(
                body.get('player_name', 'プレイヤー'),
                own['cards'], opponent['cards'], own, opponent,
            )
            with TABLES_LOCK:
                TABLES[table['id']] = table
            self.send_json({'table': public_table(table)}, HTTPStatus.CREATED)
            return

        if path == '/api/decks':
            try:
                sections = load_deck_config(body)
            except ValueError as error:
                self.send_json({'error': str(error)}, HTTPStatus.BAD_REQUEST)
                return
            if not any(sections.values()):
                self.send_json({'error': '保存できるカードがありません。'}, HTTPStatus.BAD_REQUEST)
                return
            deck_data = {
                zone: [
                    {'id': card['id'], 'image_index': int(card.get('_image_index', 0))}
                    for card in cards
                ]
                for zone, cards in sections.items()
            }
            deck_data['allow_size_exceptions'] = body.get('allow_size_exceptions') is True
            saved_at = datetime.now(timezone.utc).isoformat()
            deck_id = 'deck-{}-{}.json'.format(
                datetime.now().strftime('%Y%m%d-%H%M%S'),
                uuid.uuid4().hex[:8],
            )
            name = str(body.get('name') or '').strip() or 'デッキ {}'.format(datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
            DECK_DIRECTORY.mkdir(parents=True, exist_ok=True)
            deck_path = DECK_DIRECTORY / deck_id
            deck_path.write_text(json.dumps({
                'format': 'dm-table-forge-deck',
                'version': 4,
                'name': name,
                **deck_data,
                'saved_at': saved_at,
            }, ensure_ascii=False, indent=2), encoding='utf-8')
            self.send_json({'deck': {
                'id': deck_id,
                'name': name,
                **deck_data,
                'card_count': len(sections['cards']),
                'saved_at': saved_at,
            }}, HTTPStatus.CREATED)
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
                viewer_index = None
                viewer_role = 'player'
                command_body = body
                if table.get('mode') == 'online':
                    viewer = online_viewer(table, self.player_token(parse_qs(parsed.query)))
                    if viewer is None:
                        self.send_json({'error': 'この部屋への接続情報を確認できません。'}, HTTPStatus.FORBIDDEN)
                        return
                    viewer_index = viewer['player_index']
                    viewer_role = viewer['role']
                    if viewer_role == 'spectator':
                        self.send_json({'table': public_table(table, None, 'spectator'), 'error': '観戦者はカードを操作できません。'}, HTTPStatus.FORBIDDEN)
                        return
                    command_body, error = authorize_online_command(table, viewer_index, command, body)
                    if command_body is None:
                        self.send_json({'table': public_table(table, viewer_index, viewer_role), 'error': error}, HTTPStatus.FORBIDDEN)
                        return
                ok, error = apply_command(table, command, command_body)
                response = {'table': public_table(table, viewer_index, viewer_role)}
                if command == 'view_deck':
                    response['deck_view'] = deck_view(table, int(command_body.get('player', 0)), int(command_body.get('count', 40)))
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
