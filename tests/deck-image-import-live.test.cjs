// Real pDM HTTP + Dscan + browser. Uses local dm_data; test decks stay under work/.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const project = path.resolve(__dirname, '..');

async function run() {
  fs.mkdirSync(path.join(project, 'work'), { recursive: true });
  const python = process.env.PDM_TEST_PYTHON || path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const service = spawn(python, ['-X', 'utf8', '-u', '-c',
    'import server,tempfile; from pathlib import Path; from http.server import ThreadingHTTPServer; server.DECK_DIRECTORY=Path(tempfile.mkdtemp(prefix="import-test-decks-",dir="work")); http=ThreadingHTTPServer(("127.0.0.1",0),server.SimulatorHandler); print("TEST_URL=http://127.0.0.1:"+str(http.server_port),flush=True); http.serve_forever()'],
    { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  service.stderr.on('data', (data) => { log += data; });
  let browser;
  try {
    const url = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Test server startup timeout: ' + log)), 15000);
      service.once('error', (error) => { clearTimeout(timeout); reject(error); });
      service.once('exit', (code) => { clearTimeout(timeout); reject(new Error('Test server exited: ' + code + log)); });
      service.stdout.on('data', (data) => { const match = data.toString().match(/TEST_URL=(http:\/\/\S+)/); if (match) { clearTimeout(timeout); resolve(match[1]); } });
    });
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(20000);
    const errors = [];
    let actualResponse;
    await page.route('**/api/deck-imports', async (route) => {
      const response = await route.fetch({ timeout: 180000 });
      actualResponse = { status: response.status(), body: await response.json() };
      await route.fulfill({ response });
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.locator('#db-status.ready').waitFor();
    await page.locator('#import-deck-image').click();
    await page.locator('#import-file').setInputFiles(path.join(__dirname, 'fixtures/deck-list.png'));
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/deck-imports'), { timeout: 180000 });
    const started = Date.now();
    await page.locator('#import-analyze').click();
    const response = await responsePromise;
    const result = actualResponse.body;
    assert.equal(actualResponse.status, 200, JSON.stringify(result));
    assert.equal(result.detected_count, 40);
    assert.ok(result.reference_count > 0);
    await page.locator('#import-review:not(.hidden)').waitFor();
    assert.equal(await page.evaluate(() => state.deck.length), 0);
    const current = result.cards.find((row) => row.requires_review).candidates[0];
    const preferred = page.locator(`#import-candidates .import-choice[data-import-card="${current.card.id}"]`);
    assert.equal(Number(await preferred.getAttribute('data-import-image')), current.image_index);
    await page.screenshot({ path: path.join(project, 'work/deck-import-review.png'), fullPage: true });
    await page.locator('#import-accept-all').click();
    await page.locator('#deck-image-import').waitFor({ state: 'hidden' });
    const state = await page.evaluate(() => ({ deck: window.eval('state.deck'), special: window.eval('state.specialDecks') }));
    assert.equal(state.deck.length + Object.values(state.special).reduce((total, cards) => total + cards.length, 0), 40);
    const expected = result.cards.map((row) => ({ id: row.candidates[0].card.id, image_index: row.candidates[0].image_index }));
    const normalize = (entries) => entries.map((entry) => `${entry.id}:${entry.image_index}`).sort();
    assert.deepEqual(normalize([...state.deck, ...Object.values(state.special).flat()]), normalize(expected));
    page.once('dialog', (dialog) => dialog.accept('Dscan integration test'));
    await page.locator('#save-deck').click();
    await page.locator('[data-saved-deck]').first().waitFor();
    const saved = await page.locator('[data-saved-deck]').first().getAttribute('data-saved-deck');
    await page.locator('#clear-deck').click();
    await page.locator(`[data-saved-deck="${saved}"]`).click();
    await page.waitForFunction(() => state.deck.length + Object.values(state.specialDecks).reduce((n, cards) => n + cards.length, 0) === 40);
    assert.deepEqual(await page.evaluate(() => ({ deck: state.deck, special: state.specialDecks })), state);
    await page.screenshot({ path: path.join(project, 'work/deck-import-result.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ status: 'PASS', detected: result.detected_count, references: result.reference_count,
      review: result.review_count, mainDeck: state.deck.length, elapsedSeconds: (Date.now() - started) / 1000,
      checks: 'Real upload/Dscan/printing mapping/bulk import/normal save and reload' }));
  } finally {
    if (browser) await browser.close();
    service.kill();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
