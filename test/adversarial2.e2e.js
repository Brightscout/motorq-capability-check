/**
 * Adversarial QA, round 2: black-box tests that drive dist/test-form.html in
 * headless Chromium like a real user.
 *
 * Not part of `npm test` (Playwright is not a project dependency). Run:
 *   npm run build
 *   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test --test-concurrency=1 test/adversarial2.e2e.js
 *
 * "G.." tests start with the QA finding ID they cover. "HOLDS" tests check
 * behavior that already worked. All of them should pass.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PW);
const PAGE_PATH = path.join(__dirname, '..', 'dist', 'test-form.html');
const PAGE = pathToFileURL(PAGE_PATH).href;
const HTML = fs.readFileSync(PAGE_PATH, 'utf8');

const A = '1HGCM82633A004352';
const B = '5YJSA1E26HF000337';

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

/** Opens the test form. `html` lets a test change the markup (e.g. Webflow-style). */
async function open({ html, context: ctxOpts } = {}) {
  const context = await browser.newContext(ctxOpts || {});
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  if (html) await page.setContent(html, { waitUntil: 'load' });
  else await page.goto(PAGE);
  await page.uncheck('#t-reset');
  // Count every mocked request: the mock writes "POST <target>…" to the log once
  // per request (a MutationObserver would merge two writes made in one task).
  await page.evaluate(() => {
    window.__posts = [];
    const log = document.getElementById('t-log');
    const d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(log, 'textContent', {
      get() { return d.get.call(this); },
      set(v) { if (/^POST /.test(v) && !/→/.test(v)) window.__posts.push(v); d.set.call(this, v); },
    });
  });
  return { page, context, dialogs };
}

const step = (page) => page.textContent('#t-step');
const posts = (page) => page.evaluate(() => window.__posts.length);
const payload = (page) => page.evaluate(() => {
  const t = document.getElementById('t-log').textContent;
  return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
});

// Upload File and Paste VINs are tabs; Upload is the default one.
const pasteTab = (page) => page.click('[data-tab="paste"]');

async function pasteAndContinue(page, text) {
  await pasteTab(page);
  await page.fill('[data-field="vins-text"]', text);
  await page.click('[data-action="vins-submit"]');
}
async function fillDetails(page, { name = 'Jane Doe', email = 'jane@acme.com' } = {}) {
  const [first, ...rest] = name.split(' ');
  await page.fill('[data-field="first-name"]', first);
  await page.fill('[data-field="last-name"]', rest.join(' ') || 'Doe');
  await page.fill('[data-field="email"]', email);
  await page.check('#mock-turnstile');
}
const csvFile = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

/* ---------------- Findings ---------------- */

test('G01 [Req 5/3] uploading a normal Excel CSV export with a comma inside a quoted cell reaches step 2 with 2 VINs', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', csvFile('fleet.csv', `Make,Model,VIN\r\nHonda,Accord,${A}\r\nTesla,"Model S, Long Range",${B}\r\n`));
  await page.click('[data-action="vins-submit"]');
  await page.waitForTimeout(300);
  const err = await page.textContent('[data-error="vins"]');
  assert.strictEqual(await step(page), 'details', `stuck on step 1 with: "${err}"`);
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');
  await context.close();
});

test('G02 [Req 5/8] pasting a table copied from a PDF/email sends only the VINs', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, `Unit Make Model VIN\n12 Honda Accord ${A}\n13 Tesla ModelS ${B}`);
  assert.strictEqual(await step(page), 'details');
  await fillDetails(page);
  await page.click('[data-action="details-submit"]');
  await page.waitForFunction(() => /→/.test(document.getElementById('t-log').textContent));
  // Actual: "12,HONDA,ACCORD,1HG…,13,TESLA,MODELS,5YJ…" and the screen says "8 VINs".
  assert.strictEqual((await payload(page)).vins, `${A},${B}`);
  await context.close();
});

test('G09 [Req 8] Webflow-style link button: double-clicking "Email My Results" sends ONE POST', async () => {
  // Webflow's Button element is <a class="w-button" href="#">, not <button>.
  const html = HTML.replace('<button class="primary" data-action="details-submit">Email My Results</button>',
    '<a href="#" class="primary" data-action="details-submit">Email My Results</a>');
  assert.notStrictEqual(html, HTML);
  const { page, context } = await open({ html });
  await pasteAndContinue(page, `${A}\n${B}`);
  await fillDetails(page);
  await page.dblclick('[data-action="details-submit"]');
  await page.waitForTimeout(1200);
  assert.strictEqual(await posts(page), 1, 'duplicate POST to the Motorq API');
  await context.close();
});

test('G13 [Req 10] inside a <form> (Webflow Form Block): pressing Enter in step 2 does not delete the uploaded file', async () => {
  const html = HTML.replace('<div class="card" id="cap-check">', '<form class="card" id="cap-check">')
    .replace(/<\/section>\s*<\/div>\s*<\/main>/, '</section></form></main>');
  assert.notStrictEqual(html, HTML);
  const { page, context } = await open({ html });
  await page.setInputFiles('[data-field="file"]', csvFile('fleet.csv', `VIN\n${A}\n${B}\n`));
  await page.click('[data-action="vins-submit"]');
  await page.waitForTimeout(300);
  assert.strictEqual(await step(page), 'details');
  await page.fill('[data-field="first-name"]', 'Jane');
  await page.press('[data-field="first-name"]', 'Enter'); // natural keyboard habit
  await page.click('[data-step="details"] [data-action="back"]');
  // Actual: Enter = implicit submit = click on the form's first button, the hidden "Remove" link.
  assert.strictEqual(await page.textContent('[data-file-name]'), 'fleet.csv', 'the selected file was removed');
  await context.close();
});

test('G18 [Req 10, Needs decision] browser/Android Back on step 2 returns to step 1 instead of leaving the page', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.goto(PAGE);
  await pasteTab(page);
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.click('[data-action="vins-submit"]');
  assert.strictEqual(await step(page), 'details');
  await page.goBack();
  // Actual: the browser leaves the page; everything the user entered is gone.
  assert.ok(page.url().startsWith('file:'), `left the form: now at ${page.url()}`);
  await context.close();
});

/* ---------------- Held up ---------------- */

test('HOLDS [Req 1] Paste button does not read the clipboard; it focuses the text field and keeps existing text', async () => {
  const { page, context } = await open({ context: { permissions: ['clipboard-read', 'clipboard-write'], viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true } });
  await page.evaluate(() => {
    window.__clip = 0;
    if (navigator.clipboard) navigator.clipboard.readText = () => { window.__clip++; return Promise.resolve('X'); };
  });
  await page.tap('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', A);
  await page.tap('[data-action="paste"]');
  assert.strictEqual(await page.evaluate(() => window.__clip), 0);
  assert.strictEqual(await page.evaluate(() => document.activeElement.getAttribute('data-field')), 'vins-text');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), A);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll at 375px');
  await context.close();
});

test('HOLDS [Req 2] Excel "Unicode Text" (.txt, UTF-16LE with BOM, tab-separated) is read', async () => {
  const { page, context } = await open();
  const u16 = Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(`VIN\tMake\r\n${A}\tHonda\r\n${B}\tTesla\r\n`, 'utf16le')]);
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.txt', mimeType: 'text/plain', buffer: u16 });
  await page.click('[data-action="vins-submit"]');
  await page.waitForTimeout(300);
  assert.strictEqual(await step(page), 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');
  await context.close();
});

test('HOLDS [Req 7] full-width "ｇｍａｉｌ.com" in a type=email field is normalized by Chromium and blocked', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, A);
  await fillDetails(page, { email: 'jane@\uFF47\uFF4D\uFF41\uFF49\uFF4C.com' });
  await page.click('[data-action="details-submit"]');
  assert.strictEqual(await page.textContent('[data-error="details"]'), 'Please use your work email.');
  assert.strictEqual(await posts(page), 0);
  await context.close();
});

test('HOLDS [Req 8/12] <button> double-click sends one POST; after a 500 the user re-verifies and the retry succeeds', async () => {
  const { page, context, dialogs } = await open();
  await pasteAndContinue(page, `${A}\n${B}`);
  await fillDetails(page, { name: '<img src=x onerror=alert(1)>' });
  await page.check('#t-fail');
  await page.dblclick('[data-action="details-submit"]');
  await page.waitForFunction(() => /→ 500/.test(document.getElementById('t-log').textContent));
  assert.strictEqual(await posts(page), 1);
  assert.strictEqual(await step(page), 'details');
  assert.ok(await page.textContent('[data-error="details"]'));
  assert.strictEqual(await page.isChecked('#mock-turnstile'), false, 'Turnstile not reset after failure');
  await page.uncheck('#t-fail');
  await page.check('#mock-turnstile');
  await page.click('[data-action="details-submit"]');
  await page.waitForFunction(() => /→ 202/.test(document.getElementById('t-log').textContent));
  assert.strictEqual(await step(page), 'success');
  const p = await payload(page);
  assert.deepStrictEqual(Object.keys(p).sort(), ['email', 'fullName', 'turnstileToken', 'vins']);
  assert.strictEqual(p.vins, `${A},${B}`);
  assert.deepStrictEqual(dialogs, []);
  await context.close();
});
