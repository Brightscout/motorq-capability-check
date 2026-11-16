/**
 * Black-box QA: drives dist/test-form.html in headless Chromium like a user.
 *
 * Not picked up by `npm test` (needs Playwright, which is not a project dependency).
 * Run:
 *   npm run build
 *   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test test/adversarial.e2e.js
 * (or install playwright anywhere Node can resolve it and omit PLAYWRIGHT_PATH)
 *
 * Tests prefixed "HOLDS" check behavior that already worked; the others start
 * with the QA finding ID they cover. All of them should pass.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const XLSX = require('xlsx');

const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const PAGE = pathToFileURL(path.join(__dirname, '..', 'dist', 'test-form.html')).href;

const A = '1HGCM82633A004352';
const B = '5YJSA1E26HF000337';
const C = 'WVWZZZ1JZXW000001';

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open(opts = {}) {
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
  await page.goto(PAGE);
  // Never auto-reload after success, so we can inspect the end state.
  await page.uncheck('#t-reset');
  // Count every mocked network request (each one rewrites the log with "POST ...").
  await page.evaluate(() => {
    window.__posts = [];
    const log = document.getElementById('t-log');
    new MutationObserver(() => {
      const t = log.textContent;
      if (/^POST /.test(t) && !/→/.test(t)) window.__posts.push(t);
    }).observe(log, { childList: true, characterData: true, subtree: true });
  });
  return { page, context, dialogs };
}

const step = (page) => page.textContent('#t-step');
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

async function fillDetails(page, { name = 'Jane Doe', email = 'jane@acme.com', captcha = true } = {}) {
  const [first, ...rest] = name.split(' ');
  await page.fill('[data-field="first-name"]', first);
  await page.fill('[data-field="last-name"]', rest.join(' ') || 'Doe');
  await page.fill('[data-field="email"]', email);
  if (captcha) await page.check('#mock-turnstile');
}

function xlsxBuffer(aoa, bookType = 'xlsx') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Fleet');
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType }));
}

/* ---------------- Things that should hold ---------------- */

test('HOLDS [Req 8] happy path sends exactly fullName, email, vins (no spaces), turnstileToken', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, `VIN\n  ${A.toLowerCase()} ,${B}\n\n${A}\n${C}  `);
  assert.strictEqual(await step(page), 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '3');
  await fillDetails(page, { email: '  Jane@Acme.COM ' });
  await page.click('[data-action="details-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'success');
  const p = await payload(page);
  assert.deepStrictEqual(Object.keys(p).sort(), ['email', 'fullName', 'turnstileToken', 'vins']);
  assert.strictEqual(p.vins, `${A},${B},${C}`);
  assert.strictEqual(p.email, 'jane@acme.com');
  await context.close();
});

test('HOLDS [Req 6] 1,000 → step 2; 1,001 → Talk to an Expert; 1,001 with a duplicate → step 2', async () => {
  const { page, context } = await open();
  const vins = (n) => Array.from({ length: n }, (_, i) => 'TEST' + String(i).padStart(13, '0'));
  await pasteAndContinue(page, vins(1000).join('\n'));
  assert.strictEqual(await step(page), 'details');
  await page.click('[data-step="details"] [data-action="back"]');
  await pasteAndContinue(page, vins(1001).join('\n'));
  assert.strictEqual(await step(page), 'expert');
  assert.strictEqual(await page.isVisible('[data-error="vins"]'), false, 'over 1,000 must not be shown as an error');
  await page.click('[data-step="expert"] [data-action="back"]');
  await pasteAndContinue(page, vins(1000).concat(['test0000000000000']).join('\n'));
  assert.strictEqual(await step(page), 'details');
  await context.close();
});

test('HOLDS [Req 10/12] API failure keeps the user on step 2 with their data; Back keeps step-1 input', async () => {
  const { page, context } = await open();
  const text = `${A}\n${B}`;
  await pasteAndContinue(page, text);
  await fillDetails(page);
  await page.check('#t-fail');
  await page.click('[data-action="details-submit"]');
  await page.waitForSelector('[data-error="details"]:not([hidden])');
  assert.strictEqual(await step(page), 'details');
  assert.strictEqual(await page.inputValue('[data-field="first-name"]'), 'Jane');
  assert.strictEqual(await page.inputValue('[data-field="last-name"]'), 'Doe');
  assert.strictEqual(await page.inputValue('[data-field="email"]'), 'jane@acme.com');
  await page.click('[data-step="details"] [data-action="back"]');
  assert.strictEqual(await step(page), 'vins');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), text);
  await context.close();
});

test('HOLDS [Req 8] double-clicking "Email My Results" sends one request', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, A);
  await fillDetails(page);
  await page.dblclick('[data-action="details-submit"]');
  await page.click('[data-action="details-submit"]', { force: true }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'success');
  assert.strictEqual(await page.evaluate(() => window.__posts.length), 1);
  await context.close();
});

test('HOLDS [Req 10] pressing Back while the request is in flight does not leave step 2 mid-submit', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, A);
  await fillDetails(page);
  await page.click('[data-action="details-submit"]');
  await page.click('[data-step="details"] [data-action="back"]');
  assert.strictEqual(await step(page), 'details');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'success');
  await context.close();
});

test('HOLDS [security] XSS in file name and pasted content is rendered as text', async () => {
  const { page, context, dialogs } = await open();
  const evil = '<img src=x onerror=alert(1)>.csv';
  await page.setInputFiles('[data-field="file"]', { name: evil, mimeType: 'text/csv', buffer: Buffer.from(`VIN\n${A}\n`) });
  assert.strictEqual(await page.textContent('[data-file-name]'), evil);
  assert.strictEqual(await page.locator('[data-file-name] img').count(), 0);
  await page.click('[data-action="clear-file"]');
  await pasteAndContinue(page, '<script>alert(1)</script>');
  await page.waitForTimeout(200);
  assert.deepStrictEqual(dialogs, []);
  await context.close();
});

test('HOLDS [Req 2] .xlsx upload uses only the VIN column; .xls is rejected', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.xlsx', mimeType: 'application/octet-stream',
    buffer: xlsxBuffer([['Make', 'VIN', 'Model'], ['Honda', A, 'Accord-EX'], ['', '', ''], ['Tesla', B, 'Model S']]) });
  await page.click('[data-action="vins-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');
  await page.click('[data-step="details"] [data-action="back"]');
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.xls', mimeType: 'application/vnd.ms-excel', buffer: xlsxBuffer([['VIN'], [A]], 'xls') });
  await page.click('[data-action="vins-submit"]');
  await page.waitForSelector('[data-error="vins"]:not([hidden])');
  assert.match(await page.textContent('[data-error="vins"]'), /Unsupported file/);
  await context.close();
});

test('HOLDS [Req 6] a ~20 MB CSV (1.2M VINs) is processed in the browser and routed to Talk to an Expert', async () => {
  const { page, context } = await open();
  const big = 'VIN\r\n' + Array.from({ length: 1200000 }, (_, i) => 'T' + String(i).padStart(16, '0')).join('\r\n');
  await page.setInputFiles('[data-field="file"]', { name: 'big.csv', mimeType: 'text/csv', buffer: Buffer.from(big) });
  const t0 = Date.now();
  await page.click('[data-action="vins-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'expert', null, { timeout: 60000 });
  console.log(`# 20 MB CSV processed in ${Date.now() - t0} ms`);
  assert.strictEqual(await page.textContent('[data-step="vins"] [data-vin-count]'), '1,200,000');
  await context.close();
});

test('HOLDS [layout] mobile viewport (375px): no horizontal scroll, Paste button visible', async () => {
  const { page, context } = await open({ viewport: { width: 375, height: 740 }, isMobile: true, hasTouch: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
  await page.tap('[data-tab="paste"]');
  assert.ok(await page.isVisible('[data-action="paste"]'));
  await context.close();
});

test('HOLDS [a11y] keyboard-only: step 1 can be completed with Tab + Enter', async () => {
  const { page, context } = await open();
  await pasteTab(page);
  await page.focus('[data-field="vins-text"]');
  await page.keyboard.type(A);
  await page.keyboard.press('Tab'); // Paste
  await page.keyboard.press('Tab'); // Clear
  await page.keyboard.press('Tab'); // Get My Results
  assert.strictEqual(await page.evaluate(() => document.activeElement.dataset.action), 'vins-submit');
  await page.keyboard.press('Enter');
  assert.strictEqual(await step(page), 'details');
  await context.close();
});

/* ---------------- Findings (fail while the bug exists) ---------------- */

test('F04 [Req 5/6] a multi-column CSV only sends the VIN column (same file as .xlsx gives 2 VINs)', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.csv', mimeType: 'text/csv',
    buffer: Buffer.from(`Make,VIN,Model\r\nHonda,${A},Accord\r\nTesla,${B},Model S\r\n`) });
  await page.click('[data-action="vins-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'details');
  await fillDetails(page);
  await page.click('[data-action="details-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'success');
  assert.strictEqual((await payload(page)).vins, `${A},${B}`);
  await context.close();
});

test('HOLDS [Req 2] UTF-16 "Unicode Text" .txt export from Excel (with BOM) is decoded by the browser', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.txt', mimeType: 'text/plain',
    buffer: Buffer.from(`﻿VIN\r\n${A}\r\n${B}\r\n`, 'utf16le') });
  await page.click('[data-action="vins-submit"]');
  await page.waitForTimeout(300);
  assert.strictEqual(await step(page), 'details', `error: ${await page.textContent('[data-error="vins"]')}`);
  await context.close();
});

test('F12 [Req 2, Needs decision] an .xls renamed to .xlsx is rejected', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.xlsx', mimeType: 'application/octet-stream', buffer: xlsxBuffer([['VIN'], [A]], 'xls') });
  await page.click('[data-action="vins-submit"]');
  await page.waitForTimeout(300);
  assert.strictEqual(await step(page), 'vins', 'renamed .xls was accepted');
  await context.close();
});

// Decision (Figma flow): Upload and Paste are tabs; only the active tab is sent.
test('F16 [Req 1, decided] uploading a file AND pasting text uses the active tab (Paste)', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.csv', mimeType: 'text/csv', buffer: Buffer.from(`VIN\n${A}\n`) });
  await pasteAndContinue(page, `${B}\n${C}`);
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');
  await context.close();
});

test('F01/F02 [Req 12] an API error keeps the user on step 2 and the retry gets a fresh captcha', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, A);
  await fillDetails(page);
  await page.check('#t-fail');
  await page.click('[data-action="details-submit"]');
  await page.waitForSelector('[data-error="details"]:not([hidden])');
  assert.strictEqual(await step(page), 'details');
  assert.strictEqual(await page.isChecked('#mock-turnstile'), false, 'captcha was not reset after the failure');
  await page.uncheck('#t-fail');
  await page.check('#mock-turnstile');
  await page.click('[data-action="details-submit"]');
  await page.waitForFunction(() => document.getElementById('t-step').textContent === 'success');
  await context.close();
});

test('F23 [a11y] after Continue, keyboard focus moves into step 2 (not lost on a hidden button)', async () => {
  const { page, context } = await open();
  await pasteTab(page);
  await page.focus('[data-field="vins-text"]');
  await page.keyboard.type(A);
  await page.focus('[data-action="vins-submit"]');
  await page.keyboard.press('Enter');
  const inStep2 = await page.evaluate(() => !!document.activeElement.closest('[data-step="details"]'));
  assert.ok(inStep2, `focus is on <${await page.evaluate(() => document.activeElement.tagName)}>`);
  await context.close();
});

test('F23b [a11y] step-1 errors are announced (role=alert / aria-live)', async () => {
  const { page, context } = await open();
  await pasteAndContinue(page, `${A};${B}`);
  const err = page.locator('[data-error="vins"]');
  await err.waitFor();
  const live = await err.evaluate((n) => n.getAttribute('role') === 'alert' || !!n.getAttribute('aria-live'));
  assert.ok(live, 'error text is not announced to screen readers');
  await context.close();
});

test('F24 [Req 10] steps stay exclusive when the site CSS sets display on the step containers (typical Webflow class)', async () => {
  const { page, context } = await open();
  await page.addStyleTag({ content: '#cap-check section { display: block; }' });
  const visible = await page.evaluate(() => Array.from(document.querySelectorAll('[data-step]'))
    .filter((n) => getComputedStyle(n).display !== 'none').map((n) => n.dataset.step));
  assert.deepStrictEqual(visible, ['vins']);
  await context.close();
});
