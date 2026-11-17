/**
 * End-to-end tests for the Figma flow: Upload/Paste tabs, live VIN count,
 * first and last name, the "talk with our team" link and the new Talk to an
 * Expert fields. Drives dist/test-form.html in headless Chromium.
 *
 * Not part of `npm test` (Playwright is not a project dependency). Run:
 *   npm run build
 *   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test --test-concurrency=1 test/flow.e2e.js
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const PW = process.env.PLAYWRIGHT_PATH || 'playwright';
const { chromium } = require(PW);
const PAGE = pathToFileURL(path.join(__dirname, '..', 'dist', 'test-form.html')).href;

const A = '1HGCM82633A004352';
const B = '5YJSA1E26HF000337';
const C = 'WVWZZZ1JZXW000001';
const LIVE_WAIT = 450; // live count debounce (300 ms) plus margin

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(PAGE);
  await page.uncheck('#t-reset');
  return { page, context };
}

const step = (page) => page.textContent('#t-step');
const waitStep = (page, s) => page.waitForFunction((x) => document.getElementById('t-step').textContent === x, s);
const visible = (page, sel) => page.isVisible(sel);
const liveCount = (page) => page.textContent('[data-step="vins"] [data-vin-count]');
// A real paste: the whole text lands at once with one input event. (Playwright's
// fill() types multi-line text slowly, which is not what a user does.)
const pasteText = (page, text) => page.evaluate((v) => {
  const ta = document.querySelector('[data-field="vins-text"]');
  ta.focus();
  ta.value = v;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}, text);
const csv = (name, text) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

/** The last mocked request, parsed from the test panel log. */
async function lastRequest(page) {
  await page.waitForFunction(() => /→/.test(document.getElementById('t-log').textContent));
  const t = await page.textContent('#t-log');
  return { target: t.split('\n')[0], payload: JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)) };
}

async function fillExpert(page, { phone = '(555) 123-4567' } = {}) {
  await page.fill('[data-field="expert-first-name"]', 'Jane');
  await page.fill('[data-field="expert-last-name"]', 'Doe');
  await page.selectOption('[data-field="fleet-size"]', '50-250');
  await page.fill('[data-field="company-name"]', 'Acme Logistics');
  await page.fill('[data-field="company-email"]', 'Jane@Acme.com');
  await page.selectOption('[data-field="phone-country"]', '+52');
  await page.fill('[data-field="phone"]', phone);
}

test('tabs: Upload is active first; switching keeps each input, and only the active tab is sent', async () => {
  const { page, context } = await open();
  assert.ok(await visible(page, '[data-panel="upload"]'));
  assert.ok(!(await visible(page, '[data-panel="paste"]')));
  await page.setInputFiles('[data-field="file"]', csv('fleet.csv', `VIN\n${A}\n`));
  await page.click('[data-tab="paste"]');
  assert.ok(await visible(page, '[data-panel="paste"]'));
  assert.ok(!(await visible(page, '[data-panel="upload"]')));
  await page.fill('[data-field="vins-text"]', `${B}\n${C}`);
  await page.click('[data-tab="upload"]');
  assert.strictEqual(await page.textContent('[data-file-name]'), 'fleet.csv', 'file lost after switching tabs');
  assert.strictEqual(await liveCount(page), '1');
  await page.click('[data-tab="paste"]');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), `${B}\n${C}`, 'text lost after switching tabs');
  await page.waitForTimeout(LIVE_WAIT);
  assert.strictEqual(await liveCount(page), '2');

  // Paste tab active: the file is ignored.
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');

  // Back, switch to Upload: now only the file is used.
  await page.click('[data-step="details"] [data-action="back"]');
  await page.click('[data-tab="upload"]');
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '1');
  await context.close();
});

test('tabs: the button only enables when the active tab has content', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', A);
  assert.ok(await page.isEnabled('[data-action="vins-submit"]'));
  await page.click('[data-tab="upload"]');
  assert.ok(!(await page.isEnabled('[data-action="vins-submit"]')), 'enabled with an empty Upload tab');
  await context.close();
});

test('live count: shown for a file as soon as it is selected, before pressing the button', async () => {
  const { page, context } = await open();
  assert.ok(!(await visible(page, '[data-vins-found]')));
  await page.setInputFiles('[data-field="file"]', csv('fleet.csv', `Make,VIN\nHonda,${A}\nTesla,${B}\nVW,${C}\n`));
  await page.waitForSelector('[data-vins-found]:not([hidden])');
  assert.strictEqual(await page.textContent('[data-vins-found]'), '3 VINs found');
  assert.strictEqual(await step(page), 'vins');
  // Removing the file hides the count.
  await page.click('[data-action="clear-file"]');
  assert.ok(!(await visible(page, '[data-vins-found]')));
  await context.close();
});

test('live count: updates while typing (debounced) and stays responsive with 1,000+ VINs', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.waitForTimeout(LIVE_WAIT);
  assert.strictEqual(await page.textContent('[data-vins-found]'), '2 VINs found');
  await page.type('[data-field="vins-text"]', `\n${C}`);
  await page.waitForTimeout(LIVE_WAIT);
  assert.strictEqual(await page.textContent('[data-vins-found]'), '3 VINs found');

  const big = Array.from({ length: 5000 }, (_, i) => 'T' + String(i).padStart(16, '0')).join('\n');
  const t0 = Date.now();
  await pasteText(page, big);
  await page.waitForFunction(() => document.querySelector('[data-vins-found]').textContent === '5,000 VINs found');
  const ms = Date.now() - t0;
  console.log(`# 5,000 pasted VINs counted in ${ms} ms`);
  assert.ok(ms < 2000, `live count took ${ms} ms`);
  await context.close();
});

test('errors only after pressing the button: invalid or empty input hides the count without an error', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.waitForTimeout(LIVE_WAIT);
  assert.ok(await visible(page, '[data-vins-found]'));
  await page.fill('[data-field="vins-text"]', `${A};${B}`);
  await page.waitForTimeout(LIVE_WAIT);
  assert.ok(!(await visible(page, '[data-vins-found]')), 'count still shown for invalid input');
  assert.ok(!(await visible(page, '[data-error="vins"]')), 'error shown while typing');
  await page.click('[data-action="vins-submit"]');
  await page.waitForSelector('[data-error="vins"]:not([hidden])');
  assert.match(await page.textContent('[data-error="vins"]'), /^Invalid input/);

  // Typing again clears the error until the next submit.
  await page.fill('[data-field="vins-text"]', 'Make Model Year');
  await page.waitForTimeout(LIVE_WAIT);
  assert.ok(!(await visible(page, '[data-error="vins"]')));
  assert.ok(!(await visible(page, '[data-vins-found]')));
  await page.click('[data-action="vins-submit"]');
  await page.waitForSelector('[data-error="vins"]:not([hidden])');
  assert.strictEqual(await page.textContent('[data-error="vins"]'), 'No VINs detected.');
  await context.close();
});

test('errors only after pressing the button: unsupported file', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', { name: 'fleet.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await page.waitForTimeout(200);
  assert.ok(!(await visible(page, '[data-error="vins"]')));
  assert.ok(!(await visible(page, '[data-vins-found]')));
  await page.click('[data-action="vins-submit"]');
  await page.waitForSelector('[data-error="vins"]:not([hidden])');
  assert.match(await page.textContent('[data-error="vins"]'), /^Unsupported file/);
  await context.close();
});

test('Clear link empties the text, hides the count and the error', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  assert.ok(!(await visible(page, '[data-action="clear-text"]')));
  await page.fill('[data-field="vins-text"]', `${A};x`);
  await page.click('[data-action="vins-submit"]');
  await page.waitForSelector('[data-error="vins"]:not([hidden])');
  await page.click('[data-action="clear-text"]');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), '');
  assert.ok(!(await visible(page, '[data-error="vins"]')));
  assert.ok(!(await visible(page, '[data-vins-found]')));
  assert.ok(!(await visible(page, '[data-action="clear-text"]')));
  assert.ok(!(await page.isEnabled('[data-action="vins-submit"]')));
  await context.close();
});

test('step 2: first and last name are required; Motorq gets fullName = first + " " + last (exact payload)', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `vin\n${A.toLowerCase()}\n${B}\n${A}`);
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  await page.fill('[data-field="email"]', 'jane@acme.com');
  await page.check('#mock-turnstile');
  await page.click('[data-action="details-submit"]');
  assert.strictEqual(await page.textContent('[data-error="details"]'), 'Please enter your first name.');
  await page.fill('[data-field="first-name"]', '  Jane ');
  await page.click('[data-action="details-submit"]');
  assert.strictEqual(await page.textContent('[data-error="details"]'), 'Please enter your last name.');
  await page.fill('[data-field="last-name"]', ' van  Doe ');
  await page.click('[data-action="details-submit"]');
  await waitStep(page, 'success');
  const req = await lastRequest(page);
  assert.strictEqual(req.target, 'POST Motorq API');
  assert.deepStrictEqual(req.payload, {
    fullName: 'Jane van Doe', email: 'jane@acme.com', vins: `${A},${B}`, turnstileToken: 'mock-turnstile-token',
  });
  await context.close();
});

test('Back keeps the data: step 1 input and tab, and step 2 names and email', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  await page.fill('[data-field="first-name"]', 'Jane');
  await page.fill('[data-field="last-name"]', 'Doe');
  await page.fill('[data-field="email"]', 'jane@acme.com');
  await page.click('[data-step="details"] [data-action="back"]');
  assert.strictEqual(await step(page), 'vins');
  assert.ok(await visible(page, '[data-panel="paste"]'), 'tab changed after Back');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), `${A}\n${B}`);
  assert.strictEqual(await page.textContent('[data-vins-found]'), '2 VINs found');
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  assert.strictEqual(await page.inputValue('[data-field="first-name"]'), 'Jane');
  assert.strictEqual(await page.inputValue('[data-field="last-name"]'), 'Doe');
  assert.strictEqual(await page.inputValue('[data-field="email"]'), 'jane@acme.com');
  await context.close();
});

test('expert link from step 1 with no VINs: opens the form; payload has source "link" and no vinCount (exact payload)', async () => {
  const { page, context } = await open();
  await page.click('[data-step="vins"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  await fillExpert(page);
  await page.click('[data-action="expert-submit"]');
  await waitStep(page, 'expertSuccess');
  const req = await lastRequest(page);
  assert.strictEqual(req.target, 'POST HubSpot Forms API');
  assert.deepStrictEqual(req.payload, {
    firstName: 'Jane', lastName: 'Doe', fleetSize: '50-250', companyName: 'Acme Logistics', email: 'jane@acme.com',
    phone: '+52 (555) 123-4567', source: 'link',
  });
  await context.close();
});

test('expert link from step 1 with VINs loaded: vinCount is sent; Back returns to step 1', async () => {
  const { page, context } = await open();
  await page.setInputFiles('[data-field="file"]', csv('fleet.csv', `VIN\n${A}\n${B}\n`));
  await page.waitForSelector('[data-vins-found]:not([hidden])');
  await page.click('[data-step="vins"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  await page.click('[data-step="expert"] [data-action="back"]');
  assert.strictEqual(await step(page), 'vins');
  assert.strictEqual(await page.textContent('[data-file-name]'), 'fleet.csv');
  await page.click('[data-step="vins"] [data-action="open-expert"]');
  await fillExpert(page);
  await page.click('[data-action="expert-submit"]');
  await waitStep(page, 'expertSuccess');
  const { payload } = await lastRequest(page);
  assert.strictEqual(payload.source, 'link');
  assert.strictEqual(payload.vinCount, 2);
  await context.close();
});

test('expert link from step 2: opens the form with the processed VIN count; Back returns to step 2', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `${A}\n${B}\n${C}`);
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  await page.click('[data-step="details"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  await page.click('[data-step="expert"] [data-action="back"]');
  assert.strictEqual(await step(page), 'details');
  await page.click('[data-step="details"] [data-action="open-expert"]');
  await fillExpert(page);
  await page.check('#mock-turnstile-expert');
  await page.click('[data-action="expert-submit"]');
  await waitStep(page, 'expertSuccess');
  const { payload } = await lastRequest(page);
  assert.deepStrictEqual(payload, {
    firstName: 'Jane', lastName: 'Doe', fleetSize: '50-250', companyName: 'Acme Logistics', email: 'jane@acme.com',
    phone: '+52 (555) 123-4567', source: 'link', vinCount: 3, turnstileToken: 'mock-expert-token',
  });
  await context.close();
});

test('more than 1,000 VINs opens the expert form automatically with source "over-limit"', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await pasteText(page, Array.from({ length: 1001 }, (_, i) => 'T' + String(i).padStart(16, '0')).join('\n'));
  await page.waitForTimeout(LIVE_WAIT);
  assert.strictEqual(await page.textContent('[data-vins-found]'), '1,001 VINs found');
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'expert');
  await fillExpert(page);
  await page.click('[data-action="expert-submit"]');
  await waitStep(page, 'expertSuccess');
  const { payload } = await lastRequest(page);
  assert.deepStrictEqual(payload, {
    firstName: 'Jane', lastName: 'Doe', fleetSize: '50-250', companyName: 'Acme Logistics', email: 'jane@acme.com',
    phone: '+52 (555) 123-4567', source: 'over-limit', vinCount: 1001,
  });
  await context.close();
});

test('expert form validation: name, fleet size, company name, work email and phone; Turnstile never blocks', async () => {
  const { page, context } = await open();
  await page.click('[data-step="vins"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  const error = () => page.textContent('[data-error="expert"]');
  const submit = () => page.click('[data-action="expert-submit"]');

  assert.ok((await page.$$eval('[data-field="fleet-size"] option', (o) => o.length)) > 1, 'fleet sizes not filled');
  assert.strictEqual(await page.inputValue('[data-field="phone-country"]'), '+1', 'no default country code');
  await submit();
  assert.strictEqual(await error(), 'Please enter your first name.');
  await page.fill('[data-field="expert-first-name"]', 'Jane');
  await submit();
  assert.strictEqual(await error(), 'Please enter your last name.');
  await page.fill('[data-field="expert-last-name"]', 'Doe');
  await submit();
  assert.strictEqual(await error(), 'Please select your fleet size.');
  await page.selectOption('[data-field="fleet-size"]', '1-50');
  await submit();
  assert.strictEqual(await error(), 'Please enter your company name.');
  await page.fill('[data-field="company-name"]', 'Acme');
  await submit();
  assert.strictEqual(await error(), 'Please enter your work email.');
  await page.fill('[data-field="company-email"]', 'jane@gmail.com');
  await submit();
  assert.strictEqual(await error(), 'Please use your work email.');
  await page.fill('[data-field="company-email"]', 'jane@acme.com');
  await submit();
  assert.strictEqual(await error(), 'Please enter your phone number.');
  await page.fill('[data-field="phone"]', '555.123.4567');
  await submit();
  assert.strictEqual(await error(), 'Please enter a valid phone number.');
  await page.fill('[data-field="phone"]', '12345');
  await submit();
  assert.strictEqual(await error(), 'Please enter a valid phone number.');
  await page.fill('[data-field="phone"]', '555 123 4567');
  await submit(); // Turnstile not checked: still sent
  await waitStep(page, 'expertSuccess');
  const { payload } = await lastRequest(page);
  assert.strictEqual(payload.phone, '+1 555 123 4567');
  assert.ok(!('turnstileToken' in payload));
  await context.close();
});

test('button labels match the design', async () => {
  const { page, context } = await open();
  assert.strictEqual(await page.textContent('[data-action="vins-submit"]'), 'Get My Results');
  assert.strictEqual(await page.textContent('[data-action="details-submit"]'), 'Email My Results');
  assert.strictEqual(await page.textContent('[data-action="expert-submit"]'), 'Submit');
  await context.close();
});

test('step 2 → expert link: first name, last name and email carry over to the expert form', async () => {
  const { page, context } = await open();
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  await page.fill('[data-field="first-name"]', 'Jane');
  await page.fill('[data-field="last-name"]', 'Doe');
  await page.fill('[data-field="email"]', 'jane@acme.com');
  await page.click('[data-step="details"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  assert.strictEqual(await page.inputValue('[data-field="expert-first-name"]'), 'Jane');
  assert.strictEqual(await page.inputValue('[data-field="expert-last-name"]'), 'Doe');
  assert.strictEqual(await page.inputValue('[data-field="company-email"]'), 'jane@acme.com');
  await context.close();
});

test('results email page: expert form only, prefilled from the URL, posts to the full report form', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(PAGE + '?page=full-report&firstname=Jos%C3%A9&lastname=Doe&email=jose%40acme.com');
  await page.uncheck('#t-reset');
  assert.ok(await visible(page, '[data-step="expert"]'));
  assert.ok(!(await visible(page, '[data-step="vins"]')));
  assert.strictEqual(await page.inputValue('[data-field="expert-first-name"]'), 'José');
  assert.strictEqual(await page.inputValue('[data-field="company-email"]'), 'jose@acme.com');
  await page.selectOption('[data-field="fleet-size"]', 'More than 1,000');
  await page.fill('[data-field="company-name"]', 'Acme Logistics');
  await page.fill('[data-field="phone"]', '555 123 4567');
  await page.click('[data-action="expert-submit"]');
  await waitStep(page, 'expertSuccess');
  const { payload } = await lastRequest(page);
  assert.deepStrictEqual(payload, {
    firstName: 'José', lastName: 'Doe', fleetSize: 'More than 1,000', companyName: 'Acme Logistics',
    email: 'jose@acme.com', phone: '+1 555 123 4567', source: 'email',
  });
  assert.match(await page.textContent('#t-hubspot'), /8409589a-e0c5-411e-9a55-14aad0619df1/);
  await context.close();
});
