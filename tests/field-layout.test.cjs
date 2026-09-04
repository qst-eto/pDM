// Isolated browser regression checks. All requests use fixtures; no live server or DB is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-layout.test';
const ratio = 650 / 909;
const zones = ['deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss'];
const card = (uid, face_up = true) => ({ uid, face_up, tapped: false,
  card: face_up ? { id: uid, image_url: '/test-card.svg', civiltxt: '水', costtxt: '3' } : null });
function fixture() {
  const players = [0, 1].map((p) => ({ name: 'テスト',
    zones: Object.fromEntries(zones.map((zone) => [zone,
      ['extra', 'gachi', 'abyss', 'mana'].includes(zone) ? [] :
        Array.from({ length: zone === 'hand' ? 5 : zone === 'battle' ? 2 : 1 }, (_, i) =>
          card(`${p}-${zone}-${i}`, zone !== 'deck' && !(p === 1 && zone === 'hand')))])),
    shields: Array.from({ length: 5 }, (_, i) => card(`${p}-shield-${i}`, false)),
    shield_count: 5, counts: {},
  }));
  return { id: 'layout', players, turn: 1, active_player: 0, log: [] };
}
function counts(table) {
  table.players.forEach((p) => { p.counts = Object.fromEntries(zones.map((z) => [z, p.zones[z].length])); });
  return table;
}
async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1230, height: 860 } });
    context.setDefaultTimeout(10000);
    let table = counts(fixture());
    const commands = [], errors = [];
    context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      const json = (value) => route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/test-card.svg') return route.fulfill({ contentType: 'image/svg+xml', body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="650" height="909"><rect width="650" height="909" fill="#183f67"/><rect x="8" y="8" width="634" height="893" rx="16" fill="#548eb0" stroke="#cdeee2" stroke-width="6"/><text x="325" y="460" text-anchor="middle" font-size="70" fill="white">650 × 909</text></svg>' });
      if (url.pathname === '/api/meta') return json({ card_count: 10 });
      if (url.pathname === '/api/cards') return json({ cards: [] });
      if (url.pathname === '/api/decks') return json({ decks: [] });
      if (url.pathname === '/api/tables') { table = counts(fixture()); return json({ table }); }
      if (url.pathname === '/api/tables/layout') return json({ table });
      if (url.pathname.endsWith('/commands')) {
        const body = route.request().postDataJSON();
        commands.push(body);
        assert.equal(body.command, 'move');
        const player = table.players[0];
        const sources = Object.values(player.zones).concat([player.shields]);
        for (const uid of body.card_ids) {
          const from = sources.find((items) => items.some((item) => item.uid === uid));
          assert.ok(from, uid);
          const item = from.splice(from.findIndex((item) => item.uid === uid), 1)[0];
          player.zones[body.zone].push(item);
        }
        return json({ table: counts(table) });
      }
      const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
      return route.fulfill({ contentType: types[path.extname(file)], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    await page.goto(origin);
    // Previously saved narrow-width settings must not make the real image smaller.
    await page.evaluate(() => {
      localStorage.setItem('dm-table-forge-display-settings', JSON.stringify({ battleCardWidth: 0.45, cardHeightPercent: 100 }));
      loadDisplaySettings();
    });
    await page.locator('#start-match').click();
    const settle = () => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = () => page.evaluate(() => [...document.querySelectorAll('.field-board .zone')]
      .filter((zone) => zone.getBoundingClientRect().height > 0).map((zone) => {
        const rect = (node) => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
        const content = zone.querySelector('.zone-content');
        return { player: zone.dataset.player, zone: zone.dataset.zone, box: rect(zone), content: rect(content),
          cards: [...zone.querySelectorAll('.table-card')].map((node) => ({ tapped: node.classList.contains('tapped'),
            box: rect(node), art: rect(node.querySelector('.card-art, .card-back')) })) };
      }));
    const check = async (fill = false) => {
      await settle();
      const result = await geometry();
      for (const zone of result) for (const item of zone.cards) {
        const r = item.art, outer = zone.content;
        const message = `${zone.player}:${zone.zone} ${JSON.stringify({ r, outer })}`;
        assert.ok(r.width > 0 && r.height > 0, message);
        assert.ok(Math.abs(r.width - r.height * (item.tapped ? 1 / ratio : ratio)) < 0.04, message);
        assert.ok(r.x >= outer.x - 0.5 && r.right <= outer.right + 0.5, message);
        assert.ok(r.y >= outer.y - 0.5 && r.bottom <= outer.bottom + 0.5, message);
        if (fill && !['extra', 'gachi', 'abyss'].includes(zone.zone)) assert.ok(zone.box.height - r.height < 4.5, message);
      }
      return result;
    };
    assert.equal(await page.locator('.field-center').count(), 0);
    await check(true);
    await page.locator('.table-card[data-uid="0-battle-0"]').hover();
    const preview = await page.locator('#viewer-content .card-art').boundingBox();
    const viewer = await page.locator('#viewer-content').boundingBox();
    assert.ok(preview.x >= viewer.x && preview.x + preview.width <= viewer.x + viewer.width);
    assert.ok(Math.abs(preview.width / preview.height - ratio) < 0.003);
    const screenshot = path.join(os.tmpdir(), 'dm-field-layout-650x909.png');
    await page.screenshot({ path: screenshot });
    console.log('SCREENSHOT ' + screenshot);
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1000, height: 650 }]) {
      await page.setViewportSize(viewport);
      await check(true);
    }
    await page.setViewportSize({ width: 1230, height: 860 });
    const before = await check(true);
    await page.evaluate(() => {
      for (const p of state.table.players) for (const zone of ['battle', 'hand']) {
        const source = p.zones[zone][0];
        p.zones[zone] = Array.from({ length: 40 }, (_, i) => ({ ...source, uid: source.uid + '-many-' + i, tapped: i % 3 === 0 }));
      }
      renderTable();
    });
    const crowded = await check();
    assert.deepEqual(crowded.map((z) => z.box), before.map((z) => z.box), 'Card count/tapping must not resize any zone');
    for (const delay of [400, 1100]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      assert.deepEqual((await check()).map((z) => z.box), before.map((z) => z.box), 'Zone sizes must remain stable');
    }
    const sideGeometry = () => page.evaluate(() => [...document.querySelectorAll('.field-board > .player-area')]
      .map((node) => { const r = node.getBoundingClientRect(); return { className: node.className, height: r.height, y: r.y }; }));
    const equalSides = await sideGeometry();
    await page.evaluate(() => {
      state.displaySettings.opponentFieldSize = 70;
      state.displaySettings.selfFieldSize = 130;
      applyDisplaySettings();
      saveDisplaySettings();
    });
    await settle();
    const adjustedSides = await sideGeometry();
    assert.ok(adjustedSides[0].height < equalSides[0].height, 'Opponent field should become shorter');
    assert.ok(adjustedSides[1].height > equalSides[1].height, 'Self field should become taller');
    assert.equal(await page.locator('#opponent-field-size').inputValue(), '70');
    assert.equal(await page.locator('#self-field-size').inputValue(), '130');
    await page.evaluate(() => {
      state.displaySettings.opponentFieldSize = 100;
      state.displaySettings.selfFieldSize = 100;
      state.displaySettings.selfBattleSize = 360;
      state.displaySettings.selfLowerSize = 120;
      state.displaySettings.opponentBattleSize = 330;
      state.displaySettings.opponentLowerSize = 80;
      state.displaySettings.cardHeightPercent = 80;
      applyDisplaySettings();
    });
    await check();
    console.log('PASS field: natural image ratio, nearly full zone height, both sides, resize, crowded/tapped cards, stable zones');

    await page.locator('#back-setup').click();
    await page.locator('#start-match').click();
    await page.locator('.table-card[data-uid="0-hand-0"]').click();
    await page.locator('.table-card[data-uid="0-hand-1"]').click({ modifiers: ['Control'] });
    const menu = page.locator('#context-menu');
    for (const zone of ['extra', 'gachi', 'abyss']) {
      const uid = zone === 'extra' ? '0-hand-0' : '0-hand-1';
      await page.locator(`.table-card[data-uid="${uid}"]`).click({ button: 'right' });
      const count = commands.length;
      assert.equal(await menu.locator('.special-zone-options').isVisible(), false);
      await menu.locator('[data-special-zone-toggle]').click();
      await settle();
      assert.equal(await menu.isVisible(), true);
      assert.equal(commands.length, count);
      if (zone === 'extra') {
        await menu.locator('[data-special-zone-toggle]').click();
        assert.equal(await menu.locator('.special-zone-options').isVisible(), false);
        await menu.locator('[data-special-zone-toggle]').click();
      }
      await menu.locator(`[data-zone="${zone}"]`).click();
      await page.waitForFunction((zone) => state.table.players[0].zones[zone].length > 0, zone);
      assert.equal(commands.length, count + 1);
      assert.equal(commands.at(-1).zone, zone);
      if (zone === 'extra') assert.deepEqual(commands.at(-1).card_ids, ['0-hand-0', '0-hand-1']);
      assert.equal(await menu.isVisible(), false);
      await check();
    }
    console.log('PASS field menu: expand/collapse, preserves multiple selection, each destination sends once and reveals the zone');

    const hand = await context.newPage();
    await hand.goto(origin + '/hand.html?table=layout');
    await hand.locator('.hand-card').first().waitFor();
    const handMenu = hand.locator('#hand-menu');
    for (const zone of ['extra', 'gachi', 'abyss']) {
      const source = hand.locator('.hand-card').first();
      const uid = await source.getAttribute('data-uid');
      await source.click({ button: 'right' });
      const count = commands.length;
      await handMenu.locator('[data-special-zone-toggle]').click();
      assert.equal(await handMenu.isVisible(), true);
      assert.equal(commands.length, count);
      await handMenu.locator(`[data-zone="${zone}"]`).click();
      await hand.locator(`.hand-card[data-uid="${uid}"]`).waitFor({ state: 'detached' });
      assert.equal(commands.length, count + 1);
      assert.equal(commands.at(-1).zone, zone);
    }
    assert.deepEqual(errors, []);
    console.log('PASS remote hand menu: all three destinations, hand refresh, no uncaught browser errors');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
