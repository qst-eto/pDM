// node tests/stack-mode.test.cjs (requires Playwright and a local Chrome installation).
// Every HTTP request is intercepted: no app server, database, or external site is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm.test';

const card = (uid, face_up = true) => ({ uid, face_up, tapped: false,
  card: face_up ? { id: uid, civiltxt: '火', costtxt: '3' } : null });
const player = () => ({ name: 'dummy', zones: Object.fromEntries(
  ['deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss'].map((z) => [z, []])),
  counts: {}, shields: [], shield_count: 0 });
function fixture() {
  const table = { id: 'test', turn: 1, active_player: 0, players: [player(), player()], log: [] };
  table.players[0].zones.hand = [card('front'), card('back', false), card('third')];
  table.players[0].zones.battle = [card('battle'), card('pile')];
  table.players[0].zones.battle[1].stack = { below: [card('under')], above: [] };
  table.players[0].zones.mana = [card('mana')];
  table.players[0].shields = [card('shield', false)];
  table.players[1].zones.battle = [card('enemy')];
  for (const p of table.players) {
    for (const [zone, items] of Object.entries(p.zones)) p.counts[zone] = items.length;
    p.shield_count = p.shields.length;
  }
  return table;
}

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let table = fixture();
  let failNext = false;
  let commandDelay = 0;
  const commands = [];
  const errors = [];
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.origin !== origin) return route.abort();
    if (url.pathname === '/api/meta') return json({ card_count: 3 });
    if (url.pathname === '/api/cards') return json({ cards: [] });
    if (url.pathname === '/api/decks') return json({ decks: [] });
    if (url.pathname === '/api/tables') { table = fixture(); return json({ table }); }
    if (url.pathname === '/api/tables/test') return json({ table });
    if (url.pathname.endsWith('/commands')) {
      const body = route.request().postDataJSON();
      commands.push(body);
      if (commandDelay) await new Promise((resolve) => setTimeout(resolve, commandDelay));
      if (failNext) { failNext = false; return json({ error: 'テスト用の通信エラー' }, 400); }
      if (body.command === 'move') return json({ table });
      if (body.command === 'tap') {
        const find = (items, uid) => {
          for (const item of items) {
            if (item.uid === uid) return item;
            const nested = find([...(item.stack?.below || []), ...(item.stack?.above || [])], uid);
            if (nested) return nested;
          }
          return null;
        };
        for (const uid of body.card_ids) {
          const item = Object.values(table.players[0].zones).flatMap((items) => items).concat(table.players[0].shields)
            .map((root) => find([root], uid)).find(Boolean);
          if (item) item.tapped = body.value;
        }
        return json({ table });
      }
      assert.equal(body.command, 'stack');
      const zones = Object.values(table.players[0].zones).concat([table.players[0].shields]);
      const target = zones.flat().find((item) => item.uid === body.target_id);
      assert.ok(target);
      target.stack ||= { below: [], above: [] };
      for (const uid of body.card_ids) {
        const sourceZone = zones.find((items) => items.some((item) => item.uid === uid));
        assert.ok(sourceZone);
        target.stack[body.position].push(sourceZone.splice(sourceZone.findIndex((item) => item.uid === uid), 1)[0]);
      }
      table.log.push('stacked');
      return json({ table });
    }
    const filename = path.join(staticRoot, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (!filename.startsWith(staticRoot + path.sep) || !fs.existsSync(filename)) return route.fulfill({ status: 404, body: '' });
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    return route.fulfill({ contentType: types[path.extname(filename)], body: fs.readFileSync(filename) });
  });
  const field = await context.newPage();
  const fieldCard = (uid) => field.locator(`.table-card[data-uid="${uid}"]`);
  const mode = field.locator('#stack-mode-bar');
  const begin = async (uid) => {
    await fieldCard(uid).click({ button: 'right' });
    await field.locator('[data-menu-command="stack-details"]').click();
    await mode.waitFor({ state: 'visible' });
    // Survives the menu click's propagation and subsequent paint.
    await field.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await mode.isVisible(), true);
  };
  try {
    await field.goto(origin);
    await field.locator('#start-match').click();
    await fieldCard('pile').dispatchEvent('wheel', { deltaY: -100 });
    await field.waitForFunction(() => state.table.players[0].zones.battle.find((item) => item.uid === 'pile')?.tapped === true);
    assert.deepEqual(commands.at(-1), { command: 'tap', card_ids: ['under', 'pile'], value: true });
    assert.equal(table.players[0].zones.battle.find((item) => item.uid === 'pile').tapped, true);
    assert.equal(table.players[0].zones.battle.find((item) => item.uid === 'pile').stack.below[0].tapped, true);
    await fieldCard('pile').dispatchEvent('wheel', { deltaY: 100 });
    await field.waitForFunction(() => state.table.players[0].zones.battle.find((item) => item.uid === 'pile')?.tapped === false);
    assert.deepEqual(commands.at(-1), { command: 'tap', card_ids: ['under', 'pile'], value: false });
    console.log('PASS stacked card: wheel tap/untap updates the whole stack');
    await fieldCard('pile').click();
    await field.locator('.inspector-card[data-inspector-uid="pile"]').click();
    await field.locator('[data-inspector-move="mana"]').click();
    await field.waitForFunction(() => !document.querySelector('.inspector-card[data-inspector-uid="pile"]'));
    assert.equal(await field.locator('.inspector-card[data-inspector-uid="under"]').count(), 0);
    await field.locator('#close-inspector').click();
    console.log('PASS inspector: moving a selected stack card removes the moved stack from the detail list');
    const commandCountBeforeStack = commands.length;
    await begin('front');
    assert.match(await fieldCard('battle').getAttribute('class'), /stack-target/);
    assert.doesNotMatch(await fieldCard('enemy').getAttribute('class'), /stack-target/);
    assert.doesNotMatch(await fieldCard('front').getAttribute('class'), /stack-target/);
    await fieldCard('front').click();
    await fieldCard('enemy').click();
    assert.equal(commands.length, commandCountBeforeStack);
    await mode.locator('[data-mode-position="below"]').click();
    await fieldCard('pile').click(); // must stack instead of opening the existing pile inspector
    await mode.waitFor({ state: 'hidden' });
    assert.equal(await field.locator('#deck-inspector').isVisible(), false);
    assert.deepEqual(commands.at(-1), { command: 'stack', card_ids: ['front'], target_id: 'pile', position: 'below' });
    console.log('PASS normal: menu click, mode UI, target validation, below existing pile');

    const commandCountAfterStack = commands.length;
    await begin('back');
    await field.keyboard.press('Escape');
    await mode.waitFor({ state: 'hidden' });
    assert.equal(commands.length, commandCountAfterStack);
    await begin('back');
    failNext = true;
    await fieldCard('shield').click();
    await field.waitForFunction(() => state.stackMode && !state.stackMode.busy);
    assert.equal(await mode.isVisible(), true);
    commandDelay = 150;
    const before = commands.length;
    await fieldCard('shield').dblclick();
    await mode.waitFor({ state: 'hidden' });
    assert.equal(commands.length, before + 1);
    assert.equal(commands.at(-1).position, 'above');
    assert.equal(table.players[0].shields[0].stack.above[0].face_up, false);
    commandDelay = 0;
    console.log('PASS normal: cancel, failure/retry, double-click sends once, face-down shield stack');

    await field.locator('#back-setup').click();
    await field.locator('#play-mode').selectOption('remote');
    const handPromise = context.waitForEvent('page');
    await field.locator('#start-match').click();
    const hand = await handPromise;
    await hand.locator('.hand-card[data-uid="front"]').waitFor();
    const handMode = hand.locator('#hand-stack-mode');
    await hand.locator('.hand-card[data-uid="front"]').click();
    await hand.locator('.hand-card[data-uid="back"]').click({ modifiers: ['Control'] });
    await hand.locator('.hand-card[data-uid="front"]').click({ button: 'right' });
    await hand.locator('[data-hand-stack]').click();
    await mode.waitFor({ state: 'visible' });
    await hand.waitForFunction(() => handState.stackMode && !handState.stackMode.waiting);
    await handMode.locator('[data-mode-position="below"]').click();
    await field.waitForFunction(() => state.stackMode.position === 'below');
    await fieldCard('battle').click();
    await handMode.waitFor({ state: 'hidden' });
    await hand.locator('.hand-card[data-uid="front"]').waitFor({ state: 'detached' });
    assert.deepEqual(commands.at(-1).card_ids, ['front', 'back']);
    assert.equal(commands.at(-1).position, 'below');
    assert.deepEqual(table.players[0].zones.battle[0].stack.below.map((c) => c.face_up), [true, false]);
    console.log('PASS remote: mixed multi-selection, cross-window position, click field target, hand refresh');

    // Same-origin channel must work even without the original opener reference.
    await hand.evaluate(() => { window.opener = null; });
    await hand.locator('.hand-card[data-uid="third"]').click({ button: 'right' });
    await hand.locator('[data-hand-stack]').click();
    await mode.waitFor({ state: 'visible' });
    await hand.waitForFunction(() => handState.stackMode && !handState.stackMode.waiting);
    await field.keyboard.press('Escape');
    await handMode.waitFor({ state: 'hidden' });
    await hand.locator('.hand-card[data-uid="third"]').click({ button: 'right' });
    await hand.locator('[data-hand-stack]').click();
    await mode.waitFor({ state: 'visible' });
    await hand.keyboard.press('Escape');
    await mode.waitFor({ state: 'hidden' });
    console.log('PASS remote: no opener, cancel from either window');
    assert.deepEqual(errors, []);
    console.log('PASS no uncaught browser errors; no application server started');
  } finally {
    await context.close();
    await browser.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
