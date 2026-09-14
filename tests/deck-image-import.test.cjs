const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = 'http://dm-import.test';
const staticRoot = path.resolve(__dirname, '../static');
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const cards = [10, 20, 30, 40, 50].map((id) => ({ id, cardname: `カード${id}`, civiltxt: '火',
  home_zone: id === 30 ? 'gachi' : id === 40 ? 'extra' : null, typetxt: 'クリーチャー',
  image_url: `/api/cards/${id}/image?index=0`,
  image_options: Array.from({ length: id === 10 ? 3 : 1 }, (_, index) => ({ index, image_url: `/api/cards/${id}/image?index=${index}` })),
}));
const card = (id) => cards.find((c) => c.id === id);
const candidate = (id, imageIndex = 0, score = .85) => ({ card: card(id), image_index: imageIndex, score, variants: [] });
const scan = { detected_count: 4, review_count: 3, cards: [
  { position: 1, requires_review: false, status: 'matched', candidates: [candidate(10, 1)] },
  { position: 2, requires_review: true, status: 'ambiguous', candidates: [candidate(10), candidate(20)] },
  { position: 3, requires_review: true, status: 'ambiguous', candidates: [candidate(20), candidate(10)] },
  { position: 4, requires_review: true, status: 'unknown', candidates: [candidate(30), candidate(40)] },
].map((row) => ({ ...row, reason: '画像を選んでください。', crop_url: 'data:image/png;base64,' + pixel.toString('base64') })) };

async function run() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    context.setDefaultTimeout(10000);
    let saved = null;
    let uploadError = false;
    let uploadDelay = 0;
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (url.origin !== origin) return route.abort();
      if (url.pathname === '/api/meta') return json({ card_count: cards.length });
      if (url.pathname === '/api/cards') return json({ cards: url.searchParams.has('q') && url.searchParams.get('q') === '別のカード' ? [card(50)] : cards });
      if (/^\/api\/cards\/\d+$/.test(url.pathname)) return json(card(Number(url.pathname.split('/').at(-1))));
      if (/\/image$/.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: pixel });
      if (url.pathname === '/api/deck-imports') {
        assert.equal(request.method(), 'POST');
        assert.deepEqual(request.postDataBuffer(), pixel);
        if (uploadDelay) await new Promise((resolve) => setTimeout(resolve, uploadDelay));
        return json(uploadError ? { error: '画像を読み込めませんでした。' } : scan, uploadError ? 400 : 200);
      }
      if (url.pathname === '/api/decks') {
        if (request.method() === 'POST') { saved = { ...request.postDataJSON(), id: 'image-deck.json' }; return json({ deck: saved }); }
        return json({ decks: saved ? [{ ...saved, card_count: saved.cards.length }] : [] });
      }
      if (url.pathname === '/api/decks/image-deck.json') return json({ deck: saved });
      const file = path.resolve(staticRoot, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
      if (!file.startsWith(staticRoot + path.sep) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)], body: fs.readFileSync(file) });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(origin);
    await page.locator('[data-add-card="50"]').click();
    const readDeck = () => page.evaluate(() => ({ deck: state.deck, special: state.specialDecks }));
    const initial = await readDeck();
    const open = async (automatic = false, append = false) => {
      await page.locator('#import-deck-image').click();
      await page.locator('#import-file').setInputFiles({ name: 'デッキ.png', mimeType: 'image/png', buffer: pixel });
      if (automatic) await page.locator('#import-skip-review').check();
      if (append) await page.locator('#import-mode').selectOption('append');
      await page.locator('#import-analyze').click();
    };
    await open();
    await page.locator('#import-review:not(.hidden)').waitFor();
    assert.deepEqual(await readDeck(), initial);
    await page.locator('#import-candidates .import-candidate').first().locator('summary').click();
    await page.locator('#import-candidates .import-variant[data-import-card="10"][data-import-image="2"]').click();
    assert.match(await page.locator('#import-position').textContent(), /3 枚目/);
    await page.locator('#import-candidates .import-choice[data-import-card="20"]').click();
    await page.locator('#import-accept-all').click();
    await page.locator('#deck-image-import').waitFor({ state: 'hidden' });
    assert.deepEqual(await readDeck(), { deck: [{ id: 10, image_index: 1 }, { id: 10, image_index: 2 }, { id: 20, image_index: 0 }],
      special: { extra: [], gachi: [{ id: 30, image_index: 0 }], battle: [] } });
    assert.equal(await page.locator('#deck-list [data-deck-card="10"]').count(), 2);

    // The normal editor operates on the chosen printing's group, not all copies of a card.
    await page.locator('#deck-list [data-add-deck-copy="10"][data-copy-image="2"]').click();
    await page.locator('#deck-list [data-remove-deck="10"][data-copy-image="2"]').click();
    await page.locator('#deck-list [data-deck-image-picker="10"][data-deck-image-index="2"]').click();
    await page.locator('#image-variant-grid [data-image-index="0"]').click();
    assert.deepEqual((await readDeck()).deck.slice(0, 2), [{ id: 10, image_index: 1 }, { id: 10, image_index: 0 }]);
    const beforeSave = await readDeck();
    page.once('dialog', (dialog) => dialog.accept('画像デッキ'));
    await page.locator('#save-deck').click();
    await page.locator('[data-saved-deck="image-deck.json"]').waitFor();
    assert.deepEqual(saved.cards, beforeSave.deck);
    await page.locator('#clear-deck').click();
    await page.locator('[data-saved-deck="image-deck.json"]').click();
    await page.waitForFunction(() => state.deck.length === 3);
    assert.deepEqual(await readDeck(), beforeSave);

    // Reopening resets disabled controls; cancellation and late responses preserve the deck.
    await open();
    await page.locator('#import-review:not(.hidden)').waitFor();
    await page.locator('#close-deck-import').click();
    assert.deepEqual(await readDeck(), beforeSave);
    uploadDelay = 250;
    await open();
    await page.locator('#close-deck-import').click();
    await page.waitForTimeout(350);
    assert.deepEqual(await readDeck(), beforeSave);
    uploadDelay = 0;

    await open(true);
    await page.locator('#deck-image-import').waitFor({ state: 'hidden' });
    assert.deepEqual((await readDeck()).deck, [{ id: 10, image_index: 1 }, { id: 10, image_index: 0 }, { id: 20, image_index: 0 }]);

    // Missing candidates can be corrected through the existing library, or excluded.
    await open();
    await page.locator('#import-review:not(.hidden)').waitFor();
    await page.locator('#import-card-search').fill('別のカード');
    await page.locator('#import-search-form button').click();
    await page.locator('#import-search-results [data-import-card="50"]').click();
    await page.locator('#import-exclude').click();
    await page.locator('#import-candidates .import-choice[data-import-card="40"]').click();
    await page.locator('#import-apply').click();
    await page.locator('#deck-image-import').waitFor({ state: 'hidden' });
    assert.deepEqual(await readDeck(), { deck: [{ id: 10, image_index: 1 }, { id: 50, image_index: 0 }],
      special: { extra: [{ id: 40, image_index: 0 }], gachi: [], battle: [] } });

    const beforeFailure = await readDeck();
    uploadError = true;
    await open();
    await page.locator('#import-status.import-error').waitFor();
    assert.deepEqual(await readDeck(), beforeFailure);
    await page.locator('#close-deck-import').click();
    uploadError = false;
    await page.evaluate(() => { state.deck = Array.from({ length: 40 }, () => ({ id: 20, image_index: 0 })); renderDeck(); });
    await open(true, true);
    await page.locator('#import-status.import-error').waitFor();
    assert.match(await page.locator('#import-status').textContent(), /40枚以内/);
    assert.equal((await readDeck()).deck.length, 40);
    await page.locator('#close-deck-import').click();
    assert.deepEqual(errors, []);
    console.log('PASS image import: per-card/printing choice, bulk/automatic approval, image-preserving editor/save/reload, search, exclusion, cancel/late response, errors and atomic size validation');
  } finally { await browser.close(); }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
