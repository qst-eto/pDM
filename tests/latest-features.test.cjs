const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-latest.test';
const zones = ['deck', 'hand', 'mana', 'graveyard', 'waiting', 'battle', 'extra', 'gachi', 'abyss'];
const cards = [1, 2, 3, 4, 5].map((id) => ({
  id,
  cardname: `カード${id}`,
  civiltxt: id % 2 ? '火' : '水',
  typetxt: 'クリーチャー',
  abilitytxt: `カード${id}の能力`,
  home_zone: null,
  image_url: `/api/cards/${id}/image?index=0`,
  image_options: id === 1 ? [
    { index: 0, image_url: '/api/cards/1/image?index=0' },
    { index: 1, image_url: '/api/cards/1/image?index=1' },
  ] : [{ index: 0, image_url: `/api/cards/${id}/image?index=0` }],
}));
const card = (id) => cards[id - 1];
const item = (uid, id, tapped = false, stack = null) => ({
  uid, face_up: true, tapped, note: '', card: card(id), home_zone: null,
  stack: stack || { below: [], above: [] },
});

function player(name) {
  return {
    name,
    zones: Object.fromEntries(zones.map((zone) => [zone, []])),
    shields: [],
    counts: Object.fromEntries(zones.map((zone) => [zone, 0])),
    shield_count: 0,
    hand_revealed_to_opponent: false,
    hand_visible_to_spectators: false,
  };
}

function fixtureTable() {
  const self = player('自分');
  const opponent = player('相手');
  const lowerTapped = item('lower-tapped', 2, true);
  const top = item('stack-top', 3);
  self.zones.battle = [item('stack-root', 1, false, { below: [], above: [lowerTapped, top] }), item('drop-target', 4)];
  self.zones.hand = [item('hand-one', 1), item('hand-two', 2)];
  self.zones.graveyard = [item('grave-one', 5)];
  for (const zone of zones) self.counts[zone] = self.zones[zone].length;
  return {
    id: 'latest', room_id: 'latest', mode: 'local', status: 'ready', viewer_role: 'local',
    turn: 1, active_player: 0, first_player: 0, start_method: 'coin',
    start_message: 'コイントスの結果、自分 が先攻です。', players: [self, opponent], log: [], spectator_count: 0,
  };
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    context.setDefaultTimeout(10000);
    const commands = [];
    const table = fixtureTable();
    const errors = [];
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (data) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/meta') return json({ card_count: cards.length });
      if (url.pathname === '/api/cards') return json({ cards });
      if (/^\/api\/cards\/\d+$/.test(url.pathname)) return json(card(Number(url.pathname.split('/').at(-1))));
      if (/^\/api\/cards\/\d+\/image$/.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
      if (url.pathname === '/api/decks') return json(request.method() === 'POST' ? { deck: { ...request.postDataJSON(), id: 'one.json' } } : { decks: [] });
      if (url.pathname === '/api/tables/latest') return json({ table });
      if (url.pathname === '/api/tables/latest/commands') {
        const body = request.postDataJSON();
        commands.push(body);
        return json({ table });
      }
      const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator('[data-add-card="1"]').click();
    await page.locator('[data-add-card="1"]').click();
    assert.equal(await page.locator('#deck-list .deck-chip').count(), 1);
    assert.match(await page.locator('#deck-list .deck-card-quantity').textContent(), /×2/);
    await page.locator('#deck-list [data-deck-image-card="1"]').selectOption('1');
    assert.deepEqual(await page.evaluate(() => state.deck), [{ id: 1, image_index: 1 }, { id: 1, image_index: 1 }]);
    assert.equal(await page.locator('.cost').count(), 0);

    await page.evaluate((nextTable) => {
      state.table = nextTable;
      state.mode = 'normal';
      document.querySelector('#setup-screen').classList.add('hidden');
      document.querySelector('#game-screen').classList.remove('hidden');
      renderTable();
    }, table);
    assert.match(await page.locator('#first-player').textContent(), /先攻：自分/);

    await page.locator('.self-hand-zone [data-uid="hand-one"]').click();
    assert.match(await page.locator('#viewer-content').textContent(), /カード1の能力/);
    await page.locator('.self-hand-zone [data-uid="hand-two"]').click({ modifiers: ['Control'] });
    await page.locator('.self-hand-zone [data-uid="hand-two"]').click({ button: 'right' });
    await page.locator('#context-menu [data-menu-command="tap"][data-value="true"]').click();
    await page.waitForTimeout(50);
    assert.deepEqual(commands.at(-1).card_ids.sort(), ['hand-one', 'hand-two']);

    await page.locator('.grave-zone[data-player="0"] .table-card').click();
    await page.locator('#deck-inspector:not(.hidden)').waitFor();
    await page.locator('#inspector-cards [data-inspector-uid="grave-one"]').click({ button: 'right' });
    assert.equal(await page.locator('#context-menu [data-menu-command="note"]').isVisible(), true);
    assert.equal(await page.locator('#context-menu [data-zone="battle"]').isVisible(), true);
    await page.keyboard.press('Escape');

    assert.equal(await page.locator('.stack-peek.tapped .card-art .card-image').count(), 1);
    const stackGeometry = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { x: box.x, right: box.right, width: box.width, height: box.height };
      };
      return {
        top: rect('[data-uid="stack-root"] > .card-art'),
        lower: rect('.stack-peek.tapped'),
        lowerArt: rect('.stack-peek.tapped > .card-art'),
      };
    });
    assert.ok(Math.abs(stackGeometry.lower.width - stackGeometry.top.height) < .1);
    assert.ok(Math.abs(stackGeometry.lower.height - stackGeometry.top.width) < .1);
    assert.ok(Math.abs(stackGeometry.lowerArt.width - stackGeometry.lower.width) < .1, JSON.stringify(stackGeometry));
    assert.ok(Math.abs(stackGeometry.lowerArt.height - stackGeometry.lower.height) < .1, JSON.stringify(stackGeometry));
    assert.ok(stackGeometry.lower.x < stackGeometry.top.x && stackGeometry.lower.right > stackGeometry.top.right);
    await page.locator('.stack-peek.tapped').hover({ position: { x: 2, y: 17 } });
    assert.match(await page.locator('#viewer-content').textContent(), /カード2の能力/);
    await page.locator('[data-uid="stack-root"]').hover({ position: { x: 17, y: 24 } });
    assert.match(await page.locator('#viewer-content').textContent(), /カード3の能力/);

    await page.locator('.self-hand-zone [data-uid="hand-one"]').click({ button: 'right' });
    await page.locator('#context-menu [data-zone="waiting"][data-keep-face-down="true"]').click();
    assert.equal(commands.at(-1).keep_face_down, true);

    const commandCount = commands.length;
    await page.evaluate(() => {
      const source = document.querySelector('[data-uid="stack-root"]');
      const target = document.querySelector('[data-uid="drop-target"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForTimeout(50);
    const stackCommand = commands.find((body, index) => index >= commandCount && body.command === 'stack');
    assert.equal(stackCommand.drag_drop, true);
    assert.deepEqual(stackCommand.card_ids, ['stack-top']);

    const beforeCtrlDrag = commands.length;
    await page.evaluate(() => {
      const source = document.querySelector('[data-uid="stack-root"]');
      const target = document.querySelector('.waiting-zone[data-player="0"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, ctrlKey: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, ctrlKey: true, dataTransfer: transfer }));
    });
    await page.waitForTimeout(50);
    const moveCommand = commands.find((body, index) => index >= beforeCtrlDrag && body.command === 'move');
    assert.deepEqual(moveCommand.card_ids, ['stack-root']);
    assert.equal(moveCommand.preserve_stack, true);

    const beforeWheel = commands.length;
    await page.evaluate(() => {
      const source = document.querySelector('[data-uid="hand-one"]');
      const transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
      document.querySelector('#field').dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
      source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    });
    await page.waitForTimeout(50);
    const flipCommand = commands.find((body, index) => index >= beforeWheel && body.command === 'flip');
    assert.deepEqual(flipCommand.card_ids, ['hand-one']);
    assert.equal(flipCommand.value, false);

    await page.locator('#restart-game').click();
    assert.equal(commands.at(-1).command, 'restart_game');
    assert.deepEqual(errors, []);
    console.log('PASS latest UI: grouped image deck, pinned hand preview, multi-menu, inspector menu, full-art stack peeks, drag stack/move/flip, private waiting, restart');
  } finally {
    await browser.close();
  }
}

run().catch((error) => { console.error(error); process.exitCode = 1; });
