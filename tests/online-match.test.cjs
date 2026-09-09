// Two isolated browser sessions exercise the room UI and player-relative field.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-online.test';
const zones = ['deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss'];
let uid = 0;
const visibleCard = (owner) => ({ id: owner + 1, cardname: `${owner ? 'ゲスト' : 'ホスト'}カード`, civiltxt: owner ? '水' : '火', costtxt: '3', abilitytxt: '公開情報' });
const instance = (owner, faceUp) => ({ uid: `online-${uid++}`, face_up: faceUp, tapped: false, card: visibleCard(owner), home_zone: null, stack: { below: [], above: [] } });
const emptyPlayer = (name) => ({ name, zones: Object.fromEntries(zones.map((zone) => [zone, []])), shields: [] });
const createPlayer = (name, owner) => {
  const player = emptyPlayer(name);
  player.zones.deck = Array.from({ length: 30 }, () => instance(owner, false));
  player.zones.hand = Array.from({ length: 5 }, () => instance(owner, true));
  player.shields = Array.from({ length: 5 }, () => instance(owner, false));
  return player;
};
const internal = { id: '123456', room_id: '123456', mode: 'online', status: 'waiting', turn: 1, active_player: 0,
  players: [createPlayer('ホスト', 0), emptyPlayer('対戦相手を待っています')] };
const tokens = ['host-token', 'guest-token'];

function publicTable(viewer) {
  const showPlayer = (player, relative) => {
    const showItem = (item, zone) => {
      const publicZone = !['deck', 'hand'].includes(zone);
      const reveal = item.face_up && (relative === 0 || publicZone);
      return { ...item, face_up: reveal, card: reveal ? item.card : null };
    };
    const result = { name: player.name, zones: {}, shields: player.shields.map((item) => showItem(item, 'shields')) };
    for (const zone of zones) result.zones[zone] = player.zones[zone].map((item) => showItem(item, zone));
    result.counts = Object.fromEntries(zones.map((zone) => [zone, player.zones[zone].length]));
    result.shield_count = player.shields.length;
    return result;
  };
  const order = [viewer, 1 - viewer];
  return { ...internal, active_player: internal.active_player === viewer ? 0 : 1,
    players: order.map((index, relative) => showPlayer(internal.players[index], relative)) };
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
    if (url.pathname === `/api/rooms/${internal.id}/join`) {
      internal.players[1] = createPlayer(request.postDataJSON().player_name, 1);
      internal.status = 'ready';
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
      if (body.command === 'move') {
        const player = internal.players[viewer];
        for (const cardId of body.card_ids) {
          const source = Object.values(player.zones).find((items) => items.some((item) => item.uid === cardId));
          assert.ok(source, 'A client may move only its own cards');
          const [item] = source.splice(source.findIndex((candidate) => candidate.uid === cardId), 1);
          item.face_up = true;
          player.zones[body.zone].push(item);
        }
      }
      if (body.command === 'end_turn') internal.active_player = 1 - internal.active_player;
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
    hostContext.setDefaultTimeout(10000); guestContext.setDefaultTimeout(10000);
    await installRoutes(hostContext); await installRoutes(guestContext);
    const host = await hostContext.newPage(); const guest = await guestContext.newPage();
    const errors = [];
    host.on('pageerror', (error) => errors.push(error.message)); guest.on('pageerror', (error) => errors.push(error.message));
    await host.goto(origin); await guest.goto(origin);
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

    const hostCard = await host.locator('.self-hand-zone .table-card').first().getAttribute('data-uid');
    await host.evaluate((cardId) => sendCommand({ command: 'move', card_ids: [cardId], zone: 'battle', target_player: 0 }), hostCard);
    await guest.waitForFunction((cardId) => state.table.players[1].zones.battle.some((item) => item.uid === cardId), hostCard);
    assert.equal(await guest.locator(`.opponent-battle-zone [data-uid="${hostCard}"]`).count(), 1);

    await host.locator('#end-turn').click();
    await guest.waitForFunction(() => state.table.active_player === 0);
    assert.equal(await host.locator('#turn-badge').textContent(), 'OPPONENT TURN');
    assert.equal(await guest.locator('#turn-badge').textContent(), 'YOUR TURN');
    await guest.reload();
    await guest.locator('#game-screen:not(.hidden)').waitFor();
    assert.equal(await guest.locator('#opponent-name').textContent(), 'ホスト');

    await host.evaluate(() => { const input = document.querySelector('#self-field-size'); input.value = '190'; input.dispatchEvent(new Event('input', { bubbles: true })); });
    assert.equal(await host.locator('#self-field-size').inputValue(), '190');
    assert.equal(await guest.locator('#self-field-size').inputValue(), '100');
    assert.deepEqual(errors, []);
    console.log('PASS online: room waiting/join, mirrored ownership, private hands, synchronized move/turn, reconnect, independent layout');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
