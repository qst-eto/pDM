// Two isolated browser sessions exercise the room UI and player-relative field.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-online.test';
const zones = ['deck', 'hand', 'mana', 'graveyard', 'waiting', 'battle', 'extra', 'gachi', 'abyss'];
let uid = 0;
const visibleCard = (owner) => ({ id: owner + 1, cardname: `${owner ? 'ゲスト' : 'ホスト'}カード`, civiltxt: owner ? '水' : '火', costtxt: '3', abilitytxt: '公開情報' });
const instance = (owner, faceUp) => ({ uid: `online-${uid++}`, face_up: faceUp, tapped: false, note: '', shown_to_opponent: false, card: visibleCard(owner), home_zone: null, stack: { below: [], above: [] } });
const emptyPlayer = (name) => ({ name, zones: Object.fromEntries(zones.map((zone) => [zone, []])), shields: [], hand_revealed_to_opponent: false, hand_visible_to_spectators: false, auto_draw_enabled: true });
const createPlayer = (name, owner) => {
  const player = emptyPlayer(name);
  player.zones.deck = Array.from({ length: 30 }, () => instance(owner, false));
  player.zones.hand = Array.from({ length: 5 }, () => instance(owner, true));
  player.shields = Array.from({ length: 5 }, () => instance(owner, false));
  return player;
};
const internal = { id: '123456', room_id: '123456', mode: 'online', status: 'waiting', turn: 1, active_player: 0,
  players: [createPlayer('ホスト', 0), emptyPlayer('対戦相手を待っています')], selections: [[], []], game_log: [] };
const tokens = ['host-token', 'guest-token', 'spectator-token'];
let spectatorJoined = false;
let leaveCalls = 0;

function publicTable(viewer) {
  const spectator = viewer >= 2;
  const showPlayer = (player, relation) => {
    const showItem = (item, zone) => {
      const publicZone = !['deck', 'hand'].includes(zone);
      const handVisible = zone === 'hand' && (relation === 'self' || (relation === 'opponent' && player.hand_revealed_to_opponent) || (relation === 'spectator' && player.hand_visible_to_spectators));
      const individuallyShown = zone === 'hand' && relation === 'opponent' && item.shown_to_opponent;
      const reveal = item.face_up && (publicZone || handVisible || individuallyShown);
      return { ...item, shown_to_opponent: relation === 'self' && item.shown_to_opponent, face_up: reveal, card: reveal ? item.card : null, note: reveal ? item.note : '' };
    };
    const result = { name: player.name, zones: {}, shields: player.shields.map((item) => showItem(item, 'shields')) };
    for (const zone of zones) result.zones[zone] = player.zones[zone].map((item) => showItem(item, zone));
    result.counts = Object.fromEntries(zones.map((zone) => [zone, player.zones[zone].length]));
    result.shield_count = player.shields.length;
    result.hand_revealed_to_opponent = player.hand_revealed_to_opponent;
    result.hand_visible_to_spectators = player.hand_visible_to_spectators;
    result.auto_draw_enabled = player.auto_draw_enabled;
    return result;
  };
  const order = spectator ? [0, 1] : [viewer, 1 - viewer];
  const relations = spectator ? ['spectator', 'spectator'] : ['self', 'opponent'];
  const gameLogKey = spectator ? 'spectator' : String(viewer);
  const remoteSelected = spectator ? internal.selections.flat() : internal.selections[1 - viewer];
  return { ...internal, viewer_role: spectator ? 'spectator' : 'player', spectator_count: spectatorJoined ? 1 : 0,
    active_player: spectator ? internal.active_player : internal.active_player === viewer ? 0 : 1,
    game_log: internal.game_log.map((entry) => ({ id: entry.id, kind: entry.kind, turn: entry.turn, message: entry.messages[gameLogKey] })),
    remote_selected_card_ids: remoteSelected,
    players: order.map((index, relative) => showPlayer(internal.players[index], relations[relative])) };
}

async function installRoutes(context) {
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/meta') return json({ card_count: 2 });
    if (url.pathname === '/api/cards') return json({ cards: [] });
    if (url.pathname === '/api/decks') return json({ decks: [] });
    if (url.pathname === '/api/rooms') return json({ table: publicTable(0), room_id: internal.id, player_token: tokens[0] }, 201);
    if (url.pathname === `/api/rooms/${internal.id}/leave`) { leaveCalls += 1; return json({ left: true, room_closed: false }); }
    if (url.pathname === `/api/rooms/${internal.id}/join`) {
      if (internal.status === 'ready') { spectatorJoined = true; return json({ table: publicTable(2), room_id: internal.id, player_token: tokens[2], viewer_role: 'spectator' }); }
      internal.players[1] = createPlayer(request.postDataJSON().player_name, 1);
      internal.status = 'ready';
      internal.game_log = [{ id: 'coin-1', kind: 'coin', turn: 1, messages: {
        0: 'コイントスの結果、ホスト が先攻です。', 1: 'コイントスの結果、ホスト が先攻です。', spectator: 'コイントスの結果、ホスト が先攻です。',
      } }];
      return json({ table: publicTable(1), room_id: internal.id, player_token: tokens[1] });
    }
    if (url.pathname === `/api/tables/${internal.id}`) {
      const viewer = tokens.indexOf(request.headers()['x-player-token']);
      return viewer < 0 ? json({ error: 'forbidden' }, 403) : json({ table: publicTable(viewer) });
    }
    if (url.pathname === `/api/tables/${internal.id}/commands`) {
      const viewer = tokens.indexOf(request.headers()['x-player-token']);
      const body = request.postDataJSON();
      assert.ok(viewer >= 0);
      if (viewer >= 2) return json({ error: '観戦者はカードを操作できません。' }, 403);
      if (body.command === 'move') {
        const player = internal.players[viewer];
        for (const cardId of body.card_ids) {
          const sourceEntry = Object.entries(player.zones).find(([, items]) => items.some((item) => item.uid === cardId));
          const source = sourceEntry?.[1];
          assert.ok(source, 'A client may move only its own cards');
          const [item] = source.splice(source.findIndex((candidate) => candidate.uid === cardId), 1);
          item.face_up = true;
          player.zones[body.zone].push(item);
          const message = `「${item.card.cardname}」：${sourceEntry[0]} → ${body.zone}`;
          internal.game_log.push({ id: `move-${internal.game_log.length}`, kind: 'move', turn: internal.turn, messages: { 0: message, 1: message, spectator: message } });
        }
      }
      if (body.command === 'set_note') {
        const card = Object.values(internal.players[viewer].zones).flat().find((item) => body.card_ids.includes(item.uid));
        assert.ok(card); card.note = body.note;
      }
      if (body.command === 'set_hand_visibility') {
        const key = body.audience === 'opponent' ? 'hand_revealed_to_opponent' : 'hand_visible_to_spectators';
        internal.players[viewer][key] = body.value;
      }
      if (body.command === 'set_hand_card_visibility') {
        const hand = internal.players[viewer].zones.hand;
        const selected = hand.filter((item) => body.card_ids.includes(item.uid));
        assert.equal(selected.length, body.card_ids.length, 'Only the owner may reveal their hand cards');
        selected.forEach((item) => { item.shown_to_opponent = body.value; });
      }
      if (body.command === 'set_selection') internal.selections[viewer] = [...body.card_ids];
      if (body.command === 'set_auto_draw') internal.players[viewer].auto_draw_enabled = body.value;
      if (body.command === 'end_turn') {
        internal.active_player = 1 - internal.active_player;
        const player = internal.players[internal.active_player];
        if (player.auto_draw_enabled && player.zones.deck.length) {
          const item = player.zones.deck.shift();
          item.face_up = true;
          player.zones.hand.push(item);
          const owner = internal.active_player;
          internal.game_log.push({ id: `draw-${internal.game_log.length}`, kind: 'move', turn: internal.turn, messages: {
            0: owner === 0 ? `「${item.card.cardname}」：山札 → 手札` : '非公開カード：山札 → 手札',
            1: owner === 1 ? `「${item.card.cardname}」：山札 → 手札` : '非公開カード：山札 → 手札',
            spectator: '非公開カード：山札 → 手札',
          } });
        }
      }
      return json({ table: publicTable(viewer) });
    }
    const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
    if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)], body: fs.readFileSync(file) });
  });
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const hostContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const guestContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const spectatorContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    hostContext.setDefaultTimeout(10000); guestContext.setDefaultTimeout(10000); spectatorContext.setDefaultTimeout(10000);
    await installRoutes(hostContext); await installRoutes(guestContext); await installRoutes(spectatorContext);
    const host = await hostContext.newPage(); const guest = await guestContext.newPage(); const spectator = await spectatorContext.newPage();
    const errors = [];
    host.on('pageerror', (error) => errors.push(error.message)); guest.on('pageerror', (error) => errors.push(error.message)); spectator.on('pageerror', (error) => errors.push(error.message));
    await host.goto(origin); await guest.goto(origin); await spectator.goto(origin);
    await host.locator('#play-mode').selectOption('online_host');
    await host.locator('#player-name').fill('ホスト');
    await host.locator('#start-match').click();
    await host.locator('#turn-badge').filter({ hasText: '対戦相手を待っています' }).waitFor();
    assert.match(await host.locator('#table-id').textContent(), /123456/);
    assert.equal(await host.locator('.opponent-area .table-card').count(), 0);

    await guest.locator('#play-mode').selectOption('online_join');
    await guest.locator('#player-name').fill('ゲスト');
    await guest.locator('#room-code').fill('123456');
    await guest.locator('#start-match').click();
    await host.waitForFunction(() => state.table?.status === 'ready');
    assert.equal(await host.locator('#opponent-name').textContent(), 'ゲスト');
    assert.equal(await guest.locator('#opponent-name').textContent(), 'ホスト');
    assert.equal(await host.locator('.self-hand-zone .card-back').count(), 0);
    assert.equal(await host.locator('.opponent-hand-zone .card-back').count(), 5);
    assert.equal(await guest.locator('.self-hand-zone .card-back').count(), 0);
    assert.equal(await guest.locator('.opponent-hand-zone .card-back').count(), 5);
    assert.equal(await host.locator('.opponent-area .table-card').first().getAttribute('draggable'), 'false');
    assert.equal(await host.locator('.opponent-area').evaluate((node) => getComputedStyle(node).opacity), '1');
    assert.match(await host.locator('#game-log-content').textContent(), /コイントス.*ホスト.*先攻/);
    assert.match(await guest.locator('#game-log-content').textContent(), /コイントス.*ホスト.*先攻/);

    await spectator.locator('#play-mode').selectOption('online_join');
    await spectator.locator('#room-code').fill('123456');
    await spectator.locator('#start-match').click();
    await spectator.locator('#turn-badge').filter({ hasText: '観戦中' }).waitFor();
    assert.equal(await spectator.locator('.table-card[draggable="true"]').count(), 0);
    assert.equal(await spectator.locator('#end-turn').isDisabled(), true);
    assert.equal(await spectator.locator('.self-hand-zone .card-back').count(), 5);
    await spectator.reload();
    await spectator.locator('#turn-badge').filter({ hasText: '観戦中' }).waitFor();
    assert.equal(await spectator.locator('.table-card[draggable="true"]').count(), 0);
    assert.match(await spectator.locator('#game-log-content').textContent(), /コイントス.*ホスト.*先攻/);

    const selectedGuestCard = await host.locator('.opponent-hand-zone .table-card').first().getAttribute('data-uid');
    await host.locator(`.opponent-hand-zone [data-uid="${selectedGuestCard}"]`).click();
    assert.match(await host.locator(`.opponent-hand-zone [data-uid="${selectedGuestCard}"]`).getAttribute('class'), /selected/);
    assert.equal(await host.locator(`.opponent-hand-zone [data-uid="${selectedGuestCard}"] .card-back`).count(), 1);
    await guest.waitForFunction((cardId) => document.querySelector(`.self-hand-zone [data-uid="${cardId}"]`)?.classList.contains('opponent-selected'), selectedGuestCard);
    await spectator.waitForFunction((cardId) => document.querySelector(`.opponent-hand-zone [data-uid="${cardId}"]`)?.classList.contains('opponent-selected'), selectedGuestCard);
    await host.locator('#clear-selection').click();
    await guest.waitForFunction((cardId) => !document.querySelector(`.self-hand-zone [data-uid="${cardId}"]`)?.classList.contains('opponent-selected'), selectedGuestCard);

    const selectivelyShown = await host.locator('.self-hand-zone .table-card').first().getAttribute('data-uid');
    await host.locator(`.self-hand-zone [data-uid="${selectivelyShown}"]`).click({ button: 'right' });
    assert.equal(await host.locator('#context-menu [data-menu-command="show-hand-card"]').textContent(), '相手に見せる');
    await host.locator('#context-menu [data-menu-command="show-hand-card"]').click();
    await guest.waitForFunction((cardId) => state.table.players[1].zones.hand.filter((item) => item.card).map((item) => item.uid).join() === cardId, selectivelyShown);
    assert.equal(await host.locator(`.self-hand-zone [data-uid="${selectivelyShown}"] .shown-card-badge`).textContent(), '相手に公開中');
    assert.equal(await spectator.locator('.self-hand-zone .card-back').count(), 5);
    await host.locator(`.self-hand-zone [data-uid="${selectivelyShown}"]`).click({ button: 'right' });
    assert.equal(await host.locator('#context-menu [data-menu-command="show-hand-card"]').textContent(), '相手に見せるのをやめる');
    await host.locator('#context-menu [data-menu-command="show-hand-card"]').click();
    await guest.waitForFunction(() => state.table.players[1].zones.hand.every((item) => !item.card));
    assert.equal(await host.locator('.self-hand-zone .shown-card-badge').count(), 0);

    await host.locator('#toggle-spectator-hand').click();
    await spectator.waitForFunction(() => state.table.players[0].zones.hand.every((item) => item.card));
    assert.equal(await spectator.locator('.self-hand-zone .card-back').count(), 0);
    assert.equal(await guest.locator('.opponent-hand-zone .card-back').count(), 5);
    await host.locator('#toggle-opponent-hand').click();
    await guest.waitForFunction(() => state.table.players[1].zones.hand.every((item) => item.card));
    assert.equal(await guest.locator('.opponent-hand-zone .card-back').count(), 0);

    const hostCard = await host.locator('.self-hand-zone .table-card').first().getAttribute('data-uid');
    await host.evaluate((cardId) => sendCommand({ command: 'move', card_ids: [cardId], zone: 'battle', target_player: 0 }), hostCard);
    await guest.waitForFunction((cardId) => state.table.players[1].zones.battle.some((item) => item.uid === cardId), hostCard);
    assert.equal(await guest.locator(`.opponent-battle-zone [data-uid="${hostCard}"]`).count(), 1);

    await host.locator(`.self-battle-zone [data-uid="${hostCard}"]`).click({ button: 'right' });
    await host.locator('#context-menu [data-zone="waiting"]:not([data-keep-face-down])').click();
    await host.waitForFunction((cardId) => state.table.players[0].zones.waiting.some((item) => item.uid === cardId), hostCard);
    await host.locator(`.waiting-zone[data-player="0"] [data-uid="${hostCard}"]`).click();
    await host.locator('#deck-inspector:not(.hidden)').waitFor();
    await host.locator('#close-inspector').click();
    await host.locator(`.waiting-zone[data-player="0"] [data-uid="${hostCard}"]`).click({ button: 'right' });
    host.once('dialog', (dialog) => dialog.accept('次のターンに使用'));
    await host.locator('#context-menu [data-menu-command="note"]').click();
    await guest.waitForFunction((cardId) => state.table.players[1].zones.waiting.find((item) => item.uid === cardId)?.note === '次のターンに使用', hostCard);
    assert.equal(await guest.locator(`.waiting-zone[data-player="1"] [data-uid="${hostCard}"] .card-note`).textContent(), '次のターンに使用');
    assert.match(await guest.locator('#game-log-content').textContent(), /ホストカード/);

    await guest.locator('#display-toggle').click();
    await guest.locator('#auto-draw').uncheck();
    await guest.waitForFunction(() => state.table.players[0].auto_draw_enabled === false);
    assert.equal(internal.players[1].auto_draw_enabled, false);
    const guestHandBeforeTurn = internal.players[1].zones.hand.length;
    await host.locator('#end-turn').click();
    await guest.waitForFunction(() => state.table.active_player === 0);
    assert.equal(internal.players[1].zones.hand.length, guestHandBeforeTurn);
    assert.equal(await host.locator('#turn-badge').textContent(), 'OPPONENT TURN');
    assert.equal(await guest.locator('#turn-badge').textContent(), 'YOUR TURN');
    await guest.reload();
    await guest.locator('#game-screen:not(.hidden)').waitFor();
    assert.equal(await guest.locator('#opponent-name').textContent(), 'ホスト');

    await host.evaluate(() => { const input = document.querySelector('#self-field-size'); input.value = '190'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host.locator('#self-field-size').inputValue(), '190');
    assert.equal(await guest.locator('#self-field-size').inputValue(), '100');
    await host.locator('#back-setup').click();
    await host.locator('#setup-screen:not(.hidden)').waitFor();
    assert.equal(leaveCalls, 1);
    assert.deepEqual(errors, []);
    console.log('PASS online: spectators, selected/full hand sharing, waiting zone, notes, synchronized move/turn, reconnect, independent layout');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
