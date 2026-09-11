// Isolated browser regression checks. All requests use fixtures; no live server or DB is touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const staticRoot = path.resolve(__dirname, '../static');
const origin = 'http://dm-layout.test';
const ratio = 650 / 909;
const zones = ['deck', 'hand', 'mana', 'graveyard', 'waiting', 'battle', 'extra', 'gachi', 'abyss'];
const card = (uid, face_up = true) => ({ uid, face_up, tapped: false,
  card: face_up ? { id: uid, name: uid, image_url: '/test-card.svg', civiltxt: '水', costtxt: '3', abilitytxt: `詳細 ${uid}` } : null });
function fixture() {
  const players = [0, 1].map((p) => ({ name: 'テスト',
    zones: Object.fromEntries(zones.map((zone) => [zone,
      ['extra', 'gachi', 'abyss', 'mana'].includes(zone) ? [] :
        Array.from({ length: zone === 'hand' ? 6 : zone === 'battle' ? 2 : 1 }, (_, i) =>
          card(`${p}-${zone}-${i}`, zone !== 'deck' && !(p === 1 && zone === 'hand')))])),
    shields: Array.from({ length: 5 }, (_, i) => card(`${p}-shield-${i}`, false)),
    shield_count: 5, counts: {},
  }));
  const game_log = Array.from({ length: 30 }, (_, index) => ({
    kind: index === 0 ? 'coin' : 'move',
    turn: Math.floor(index / 3) + 1,
    message: index === 0 ? 'コイントスの結果、テスト が先攻です。' : `カード${index}を手札から墓地へ移動しました。`,
  }));
  return { id: 'layout', players, turn: 1, active_player: 0, log: [], game_log };
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
        if (body.command === 'view_deck') return json({ table, deck_view: [card('deck-visible'), card('deck-hidden', false)] });
        if (body.command === 'set_hand_card_visibility') {
          const selected = table.players[0].zones.hand.filter((item) => body.card_ids.includes(item.uid));
          assert.equal(selected.length, body.card_ids.length);
          selected.forEach((item) => { item.shown_to_opponent = body.value; });
          return json({ table: counts(table) });
        }
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
        if (fill && !['extra', 'gachi', 'abyss'].includes(zone.zone)) assert.ok(zone.box.height - r.height < 0.5, message);
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
    const leftPanels = await page.evaluate(() => {
      const rect = (selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      };
      const log = document.querySelector('#game-log-content');
      return { viewer: rect('#card-viewer'), log: rect('#game-log'), board: rect('.field-board'), scrollable: log.scrollHeight > log.clientHeight };
    });
    assert.ok(leftPanels.viewer.bottom < leftPanels.log.y, JSON.stringify(leftPanels));
    assert.ok(Math.abs(leftPanels.viewer.x - leftPanels.log.x) < .1 && Math.abs(leftPanels.viewer.width - leftPanels.log.width) < .1);
    assert.ok(leftPanels.board.x > leftPanels.viewer.right);
    assert.equal(leftPanels.scrollable, true);
    assert.match(await page.locator('#game-log-content').textContent(), /コイントスの結果/);
    const screenshot = path.join(os.tmpdir(), 'dm-field-layout-650x909.png');
    await page.screenshot({ path: screenshot });
    console.log('SCREENSHOT ' + screenshot);
    // Actual inspector entry points share the normal left preview, including hidden-card clearing.
    await page.locator('[data-command="view_deck"][data-player="0"]').click();
    const inspector = page.locator('#deck-inspector');
    const visibleCard = inspector.locator('[data-inspector-uid="deck-visible"]');
    await visibleCard.hover();
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '詳細 deck-visible');
    const panel = await inspector.locator('.modal-card').boundingBox();
    const leftViewer = await page.locator('#card-viewer').boundingBox();
    assert.ok(panel.x > leftViewer.x + leftViewer.width, 'Inspector must leave the left preview unobstructed');
    assert.equal(await page.evaluate(() => {
      const r = document.querySelector('#viewer-content').getBoundingClientRect();
      return Boolean(document.elementFromPoint(r.x + r.width / 2, r.y + 30).closest('#card-viewer'));
    }), true, 'Preview must stay above the modal backdrop and receive scrolling');
    await visibleCard.click();
    assert.equal(await visibleCard.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '詳細 deck-visible');
    await page.screenshot({ path: path.join(os.tmpdir(), 'dm-zone-inspector-preview.png') });
    await inspector.locator('[data-inspector-uid="deck-hidden"]').hover();
    assert.equal(await page.locator('#viewer-content .card-art').count(), 0);
    await page.locator('#close-inspector').focus();
    await visibleCard.focus();
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '詳細 deck-visible');
    await page.keyboard.press('Escape');
    assert.equal(await inspector.isVisible(), false);
    await page.locator('.zone[data-player="0"][data-zone="graveyard"] .table-card').click();
    await inspector.locator('.inspector-card').hover();
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '詳細 0-graveyard-0');
    await page.locator('#close-inspector').click();
    console.log('PASS inspector: deck/graveyard hover, selection, keyboard focus, hidden cards, unobstructed left preview');
    for (const viewport of [{ width: 1440, height: 1000 }, { width: 1000, height: 650 }]) {
      await page.setViewportSize(viewport);
      await check(true);
    }
    await page.setViewportSize({ width: 1230, height: 860 });
    const defaults = await page.evaluate(() => ({ ...state.displaySettings }));
    const setSlider = async (id, value) => {
      await page.locator('#' + id).fill(String(value));
      await settle();
    };
    const widths = (items) => items.map((z) => [z.player, z.zone, z.box.x, z.box.width]);
    const normal = await check(true);
    await page.locator('#display-toggle').click();
    for (const value of [10, 190, 100]) {
      await setSlider('self-field-size', value);
      assert.equal(await page.locator('#opponent-field-size').inputValue(), String(200 - value));
      const result = await check();
      assert.deepEqual(widths(result), widths(normal), 'Height adjustment must never move column boundaries');
      const sizes = await page.evaluate(() => [...document.querySelectorAll('.field-board > .player-area')].map((node) => node.getBoundingClientRect().height));
      assert.ok(Math.abs(sizes[1] / (sizes[0] + sizes[1]) - value / 200) < .001, '10–190% must correspond to 5–95% of the field');
    }
    await setSlider('opponent-field-size', 190);
    assert.equal(await page.locator('#self-field-size').inputValue(), '10');
    await setSlider('self-field-size', 100);
    for (const [side, player] of [['self', '0'], ['opponent', '1']]) {
      for (const [control, zone, other] of [['primary', 'shields', 'mana'], ['mana', 'mana', 'shields']]) {
        await page.evaluate((settings) => { state.displaySettings = { ...settings }; applyDisplaySettings(); }, defaults);
        const base = await check();
        await setSlider(`${side}-${control}-size`, 250);
        const enlarged = await check();
        const height = (items, name) => items.find((z) => z.player === player && z.zone === name).box.height;
        assert.ok(height(enlarged, zone) > height(base, zone), `${side} ${control} should grow`);
        assert.ok(height(enlarged, other) < height(base, other), `${side} ${control} should have an independent weight`);
        assert.deepEqual(widths(enlarged), widths(base));
      }
    }
    await page.evaluate((settings) => { state.displaySettings = { ...settings }; applyDisplaySettings(); saveDisplaySettings(); }, defaults);
    await page.locator('#display-toggle').click();
    // Adjacent rows/columns have exactly one 1px divider and no double borders or gutters.
    await page.evaluate(() => {
      window.layoutBoundaries = [...document.querySelectorAll('.field-board .zone')].map((node) => {
        const style = getComputedStyle(node);
        return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth, style.borderRadius];
      });
    });
    for (const borders of await page.evaluate(() => window.layoutBoundaries)) assert.deepEqual(borders, ['0px', '0px', '0px', '0px', '0px']);
    const dividers = await page.evaluate(() => {
      const q = (selector) => document.querySelector(selector).getBoundingClientRect();
      const self = q('.self-area'), enemy = q('.opponent-area');
      const battle = q('.self-battle-zone'), primary = q('.self-primary-zones'), hand = q('.self-hand-zone'), mana = q('.self-mana-zone');
      const shield = q('.self-primary-zones .shield-zone'), deck = q('.self-primary-zones .deck-zone'), grave = q('.self-primary-zones .grave-column');
      return [self.y - enemy.bottom, primary.y - battle.bottom, hand.y - primary.bottom, mana.y - hand.bottom, deck.x - shield.right, grave.x - deck.right];
    });
    dividers.forEach((gap) => assert.ok(Math.abs(gap - 1) < .04, `Expected one 1px divider, got ${gap}`));
    console.log('PASS layout settings: 10/190 extremes, mirrored field sliders, independent mana/primary heights, fixed widths, single boundaries');
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
      state.displaySettings.selfPrimarySize = 45;
      state.displaySettings.selfHandSize = 44;
      state.displaySettings.selfManaSize = 31;
      state.displaySettings.opponentBattleSize = 330;
      state.displaySettings.opponentPrimarySize = 32;
      state.displaySettings.opponentHandSize = 28;
      state.displaySettings.opponentManaSize = 20;
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
    const shownSource = hand.locator('.hand-card').first();
    const shownUid = await shownSource.getAttribute('data-uid');
    await shownSource.click({ button: 'right' });
    assert.equal(await handMenu.locator('[data-hand-show]').textContent(), '相手に見せる');
    await handMenu.locator('[data-hand-show]').click();
    await hand.locator(`.hand-card[data-uid="${shownUid}"] .shown-card-badge`).waitFor();
    assert.equal(commands.at(-1).command, 'set_hand_card_visibility');
    assert.deepEqual(commands.at(-1).card_ids, [shownUid]);
    await hand.locator(`.hand-card[data-uid="${shownUid}"]`).click({ button: 'right' });
    assert.equal(await handMenu.locator('[data-hand-show]').textContent(), '相手に見せるのをやめる');
    await handMenu.locator('[data-hand-show]').click();
    await hand.locator(`.hand-card[data-uid="${shownUid}"] .shown-card-badge`).waitFor({ state: 'detached' });
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
    const waitingSource = hand.locator('.hand-card').first();
    const waitingUid = await waitingSource.getAttribute('data-uid');
    await waitingSource.click({ button: 'right' });
    await handMenu.locator('[data-zone="waiting"]:not([data-keep-face-down])').click();
    await hand.locator(`.hand-card[data-uid="${waitingUid}"]`).waitFor({ state: 'detached' });
    assert.equal(commands.at(-1).zone, 'waiting');
    // Convert earlier saved settings and persist independent weights across a real reload.
    await page.evaluate(() => {
      localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify({ selfFieldSize: 140, opponentFieldSize: 100,
        selfBattleSize: 300, selfLowerSize: 240, opponentBattleSize: 260, opponentLowerSize: 150, cardHeightPercent: 95 }));
      loadDisplaySettings();
    });
    const migrated = await page.evaluate(() => ({ ...state.displaySettings }));
    assert.ok(Math.abs(migrated.selfFieldSize - 140 / 240 * 200) < .001);
    assert.ok(Math.abs(migrated.selfPrimarySize + migrated.selfHandSize + migrated.selfManaSize - 240) < .001);
    assert.ok(Math.abs(migrated.opponentPrimarySize / migrated.opponentManaSize - 1.15 / .72) < .001);
    assert.equal(migrated.selfBattleSize, 300);
    assert.equal(migrated.selfLowerSize, undefined);
    await page.evaluate(() => {
      state.displaySettings.selfFieldSize = 190;
      state.displaySettings.selfPrimarySize = 150;
      state.displaySettings.selfManaSize = 240;
      state.displaySettings.cardHeightPercent = 100;
      applyDisplaySettings();
      saveDisplaySettings();
    });
    await page.reload();
    assert.equal(await page.locator('#self-field-size').inputValue(), '190');
    assert.equal(await page.locator('#self-primary-size').inputValue(), '150');
    assert.equal(await page.locator('#self-mana-size').inputValue(), '240');
    // The remote field excludes the detached hand from all height calculations.
    await page.locator('#play-mode').selectOption('remote');
    await page.locator('#start-match').click();
    await check();
    assert.equal(await page.locator('.self-hand-zone').isVisible(), false);
    assert.equal(await page.locator('#self-hand-size').isDisabled(), true);
    const remoteRows = await page.evaluate(() => ['.self-battle-zone', '.self-primary-zones', '.self-mana-zone'].map((selector) => document.querySelector(selector).getBoundingClientRect().height));
    assert.ok(Math.abs(remoteRows[1] / remoteRows[2] - 150 / 240) < .01);
    assert.ok(Math.abs(remoteRows[0] / remoteRows[2] - 300 / 240) < .01);
    await page.locator('.zone[data-player="0"][data-zone="graveyard"] .table-card').click();
    await page.locator('#inspector-cards .inspector-card').hover();
    assert.equal(await page.locator('#viewer-content .preview-text').textContent(), '詳細 0-graveyard-0');
    await page.locator('#close-inspector').click();
    console.log('PASS saved settings: legacy migration, reload persistence, remote independent heights and inspector preview');
    assert.deepEqual(errors, []);
    console.log('PASS remote hand menu: special and waiting destinations, hand refresh, no uncaught browser errors');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
