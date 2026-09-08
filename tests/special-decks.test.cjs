// Isolated browser checks: fixture API only; no user decks or live database are changed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-special.test';
const cards = {
  1: { id: 1, cardname: '通常カード', home_zone: null },
  2: { id: 2, cardname: '超次元 表', home_zone: 'extra', packname: '(PAIR 1/8)', face_options: [{ id: 3, cardname: '超次元 裏' }] },
  3: { id: 3, cardname: '超次元 裏', home_zone: 'extra', packname: '(PAIR 1/8)', face_options: [{ id: 2, cardname: '超次元 表' }] },
  6: { id: 6, cardname: 'ガチャレンジ', home_zone: 'gachi' },
  7: { id: 7, cardname: '開始時カード', home_zone: null },
};
for (const card of Object.values(cards)) Object.assign(card, { civiltxt: '水', typetxt: card.home_zone === 'extra' ? 'サイキック・クリーチャー' : card.home_zone === 'gachi' ? 'GRクリーチャー' : 'クリーチャー', abilitytxt: `${card.cardname}の能力` });
const zoneNames = ['deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss'];
let nextId = 0;
const item = (id, visible = true) => ({ uid: `card-${nextId++}`, home_zone: cards[id].home_zone, face_up: visible, tapped: false, card: visible ? cards[id] : null, fixtureId: id });
const count = (table) => {
  for (const p of table.players) p.counts = Object.fromEntries(zoneNames.map((z) => [z, p.zones[z].length]));
  return table;
};

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(10000);
    let saved = null, table = null, startBody = null;
    const commands = [], errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const json = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/meta') return json({ card_count: 5 });
      if (url.pathname === '/api/cards') {
        const section = url.searchParams.get('section');
        return json({ cards: Object.values(cards).filter((c) => section === 'battle' || (section === 'deck' ? !c.home_zone : c.home_zone === section)) });
      }
      if (/^\/api\/cards\/\d+$/.test(url.pathname)) return json(cards[url.pathname.split('/').at(-1)]);
      if (url.pathname === '/api/decks') {
        if (route.request().method() === 'POST') {
          saved = { ...route.request().postDataJSON(), id: 'saved.json' };
          return json({ deck: saved });
        }
        return json({ decks: saved ? [{ ...saved, card_count: saved.cards.length, gachi_count: saved.gachi.length, extra_count: saved.extra.length, battle_count: saved.battle.length }] : [] });
      }
      if (url.pathname === '/api/decks/saved.json') return json({ deck: saved });
      if (url.pathname === '/api/tables') {
        startBody = route.request().postDataJSON();
        table = { id: 'special', turn: 1, active_player: 0, log: [], players: [0, 1].map(() => ({ name: 'テスト', zones: Object.fromEntries(zoneNames.map((z) => [z, []])), shields: [], shield_count: 0 })) };
        for (const p of table.players) {
          p.zones.deck = Array.from({ length: 30 }, () => item(1, false));
          p.zones.hand = Array.from({ length: 5 }, () => item(1));
        }
        for (const section of ['extra', 'gachi', 'battle']) table.players[0].zones[section] = startBody[section].map((id) => item(id, section !== 'gachi'));
        return json({ table: count(table) });
      }
      if (url.pathname === '/api/tables/special') return json({ table });
      if (url.pathname.endsWith('/commands')) {
        const body = route.request().postDataJSON();
        commands.push(body);
        const p = table.players[0];
        const selected = Object.values(p.zones).flat().filter((c) => body.card_ids.includes(c.uid));
        if (body.command === 'turn_over') {
          for (const c of selected) { c.card = cards[body.face_id]; c.fixtureId = body.face_id; }
        } else if (body.command === 'move') {
          for (const c of selected) {
            assert.ok(!c.home_zone || [c.home_zone, 'battle', 'abyss'].includes(body.zone));
            for (const entries of Object.values(p.zones)) { const index = entries.indexOf(c); if (index >= 0) entries.splice(index, 1); }
            c.face_up = body.zone !== 'gachi';
            c.card = c.face_up ? cards[c.fixtureId] : null;
            p.zones[body.zone].push(c);
          }
        }
        return json({ table: count(table) });
      }
      const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    await page.goto(origin);
    await page.locator('[data-add-card="1"]').click();
    await page.locator('#deck-target').selectOption('gachi');
    await page.locator('[data-add-card="6"]').click();
    assert.equal(await page.locator('#start-match').isDisabled(), true);
    assert.match(await page.locator('#deck-validation').textContent(), /12枚/);
    page.on('dialog', (dialog) => dialog.accept('テスト保存'));
    await page.locator('#save-deck').click();
    await page.waitForFunction(() => document.querySelector('#notice').textContent.includes('保存しました'));
    assert.equal(saved.gachi.length, 1, 'Incomplete GR deck can be saved as a draft');
    for (let i = 0; i < 11; i++) await page.locator('[data-add-card="6"]').click();
    assert.equal(await page.locator('#start-match').isDisabled(), false);
    await page.locator('#deck-target').selectOption('extra');
    for (let i = 0; i < 9; i++) await page.locator('[data-add-card="2"]').click();
    assert.equal(await page.locator('#extra-deck-list .deck-chip').count(), 8);
    for (let i = 0; i < 7; i++) await page.locator('#extra-deck-list [data-remove-deck]').last().click();
    await page.locator('#deck-target').selectOption('battle');
    await page.locator('[data-add-card="7"]').click();
    await page.locator('#save-deck').click();
    await page.waitForFunction(() => document.querySelector('#saved-deck-list').textContent.includes('開始時 1'));
    assert.deepEqual([saved.cards, saved.extra, saved.battle], [[1], [2], [7]]);
    await page.locator('#clear-deck').click();
    await page.locator('[data-saved-deck="saved.json"]').click();
    await page.waitForFunction(() => state.specialDecks.gachi.length === 12);
    assert.equal(await page.locator('[data-deck-count="extra"]').textContent(), '1/8');
    await page.screenshot({ path: path.join(os.tmpdir(), 'dm-special-deck-builder.png') });
    await page.locator('#start-match').click();
    await page.locator('#game-screen').waitFor({ state: 'visible' });
    assert.deepEqual([startBody.deck, startBody.extra, startBody.gachi, startBody.battle], [saved.cards, saved.extra, saved.gachi, saved.battle]);
    console.log('PASS builder: four sections, filters, GR12/extra8 limits, draft save, complete save/load, separate start payload');

    const extra = page.locator('.zone[data-player="0"][data-zone="extra"] .table-card');
    const uid = await extra.getAttribute('data-uid');
    await extra.click({ button: 'right' });
    const menu = page.locator('#context-menu');
    for (const zone of ['hand', 'mana', 'graveyard', 'shields', 'deck', 'gachi']) assert.equal(await menu.locator(`[data-zone="${zone}"]`).first().isDisabled(), true);
    for (const zone of ['battle', 'extra', 'abyss']) assert.equal(await menu.locator(`[data-zone="${zone}"]`).first().isDisabled(), false);
    await menu.locator('[data-turn-over]').click();
    await page.waitForFunction((uid) => findGameItems(state.table, [uid])[0].card.id === 3, uid);
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '超次元 裏の能力');
    await extra.click();
    const inspector = page.locator('#deck-inspector');
    await inspector.locator('.inspector-card').click();
    for (const zone of ['hand', 'mana', 'graveyard', 'shields', 'gachi']) assert.equal(await inspector.locator(`[data-inspector-move="${zone}"]`).first().isDisabled(), true);
    for (const zone of ['battle', 'extra', 'abyss']) assert.equal(await inspector.locator(`[data-inspector-move="${zone}"]`).isDisabled(), false);
    await inspector.locator('.inspector-card').click({ button: 'right' });
    await menu.locator('[data-turn-over]').click();
    await page.waitForFunction((uid) => findGameItems(state.table, [uid])[0].card.id === 2, uid);
    // Turn over refreshes the inspector without losing its selected instance.
    await inspector.locator('[data-inspector-move="battle"]').click();
    await page.waitForFunction((uid) => state.table.players[0].zones.battle.some((c) => c.uid === uid), uid);
    await page.locator('#close-inspector').click();
    const before = commands.length;
    await page.evaluate((uid) => sendCommand({ command: 'move', card_ids: [uid], zone: 'mana' }), uid);
    assert.equal(commands.length, before, 'Forbidden movement must not send a request');
    const gr = page.locator('.zone[data-player="0"][data-zone="gachi"] .table-card');
    assert.equal(await gr.locator('.card-back').count(), 1);
    await gr.click({ button: 'right' });
    assert.equal(await menu.locator('[data-zone="extra"]').isDisabled(), true);
    assert.equal(await menu.locator('[data-zone="gachi"]').isDisabled(), false);
    await menu.locator('[data-zone="battle"]').click();
    await page.waitForFunction(() => state.table.players[0].zones.battle.some((c) => c.home_zone === 'gachi' && c.card?.id === 6));
    await page.locator('.zone[data-player="0"][data-zone="hand"] .table-card').first().click({ button: 'right' });
    assert.equal(await menu.locator('[data-turn-over]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS field: concealed GR, allowed/disabled destinations, GR summon, paired-face toggle, inspector toggle/move, ordinary cards unchanged');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
