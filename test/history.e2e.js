/**
 * Browser history (Back / Forward) and keyboard edge cases, in headless Chromium.
 *
 * Not part of `npm test` (Playwright is not a project dependency). Run:
 *   npm run build
 *   PLAYWRIGHT_PATH=/path/to/node_modules/playwright node --test --test-concurrency=1 test/history.e2e.js
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

let browser;
test.before(async () => { browser = await chromium.launch(); });
test.after(async () => { await browser.close(); });

async function open() {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('about:blank');
  await page.goto(PAGE);
  await page.uncheck('#t-reset');
  // A "#faq" section link, like any landing page has.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'faq-link';
    a.href = '#faq';
    a.textContent = 'FAQ';
    document.querySelector('main').prepend(a);
    const s = document.createElement('div');
    s.id = 'faq';
    s.style.height = '200px';
    document.body.appendChild(s);
  });
  return { page, context };
}

const step = (page) => page.textContent('#t-step');
const waitStep = (page, s) => page.waitForFunction((x) => document.getElementById('t-step').textContent === x, s);
const settle = (page) => page.waitForTimeout(150);

async function toDetails(page, text = `${A}\n${B}`) {
  await page.click('[data-tab="paste"]');
  await page.fill('[data-field="vins-text"]', text);
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
}

async function submitDetails(page) {
  await page.fill('[data-field="first-name"]', 'Jane');
  await page.fill('[data-field="last-name"]', 'Doe');
  await page.fill('[data-field="email"]', 'jane@acme.com');
  await page.check('#mock-turnstile');
  await page.click('[data-action="details-submit"]');
  await waitStep(page, 'success');
}

test('browser Back on step 2 returns to step 1 and keeps the input', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.goBack();
  await settle(page);
  assert.ok(page.url().startsWith('file:'), 'left the page');
  assert.strictEqual(await step(page), 'vins');
  assert.strictEqual(await page.inputValue('[data-field="vins-text"]'), `${A}\n${B}`);
  await page.goForward();
  await settle(page);
  assert.strictEqual(await step(page), 'details');
  await context.close();
});

test('a #section link on the page does not move the form (step 2 and the success screen)', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.click('#faq-link');
  await settle(page);
  assert.strictEqual(await step(page), 'details', 'a #faq link sent the form to step 1');
  await page.goBack(); // undo the scroll
  await settle(page);
  assert.strictEqual(await step(page), 'details');
  await submitDetails(page);
  await page.click('#faq-link');
  await settle(page);
  assert.strictEqual(await step(page), 'success', 'a #faq link hid the confirmation');
  await context.close();
});

test('Webflow-style pushState entries are left alone by Back and Forward', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.evaluate(() => history.pushState({ hash: '#faq' }, '', '#faq'));
  await page.goBack();
  await settle(page);
  assert.strictEqual(await step(page), 'details');
  await page.goForward();
  await settle(page);
  assert.strictEqual(await step(page), 'details', 'Forward onto a foreign entry reset the form');
  assert.deepStrictEqual(await page.evaluate(() => history.state.hash), '#faq', "the other script's state was dropped");
  await context.close();
});

test('browser Back from the success screen starts over on step 1, with a fresh captcha', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await submitDetails(page);
  await page.goBack();
  await settle(page);
  assert.strictEqual(await step(page), 'vins', 'Back reopened step 2');
  assert.strictEqual(await page.isChecked('#mock-turnstile'), false, 'captcha still checked after success');
  // Forward never shows the success screen again without sending anything.
  await page.goForward();
  await settle(page);
  assert.strictEqual(await step(page), 'vins');
  await context.close();
});

test('Back, edit the VINs, Forward: step 2 is not shown with the old VINs', async () => {
  const { page, context } = await open();
  await toDetails(page, A);
  await page.goBack();
  await settle(page);
  await page.fill('[data-field="vins-text"]', `${A}\n${B}`);
  await page.goForward();
  await settle(page);
  assert.strictEqual(await step(page), 'vins', 'Forward showed step 2 with the old VINs');
  await page.click('[data-action="vins-submit"]');
  await waitStep(page, 'details');
  assert.strictEqual(await page.textContent('[data-step="details"] [data-vin-count]'), '2');
  await context.close();
});

test('after a reload, Forward does not show step 2 or the success screen', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.goBack();
  await settle(page);
  await page.reload();
  await page.uncheck('#t-reset');
  await page.goForward();
  await settle(page);
  assert.strictEqual(await step(page), 'vins');
  await context.close();
});

test('in-form Back and browser Back stay in sync (expert from step 2)', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.click('[data-step="details"] [data-action="open-expert"]');
  await waitStep(page, 'expert');
  await page.click('[data-step="expert"] [data-action="back"]');
  await settle(page);
  assert.strictEqual(await step(page), 'details');
  await page.goBack();
  await settle(page);
  assert.strictEqual(await step(page), 'vins');
  await page.goBack();
  await settle(page);
  assert.ok(!page.url().startsWith('file:'), 'an extra Back press was needed to leave the page');
  await context.close();
});

test('Enter that confirms an IME candidate (Japanese/Chinese input) does not submit step 2', async () => {
  const { page, context } = await open();
  await toDetails(page);
  await page.focus('[data-field="first-name"]');
  await page.evaluate(() => {
    const t = document.querySelector('[data-field="first-name"]');
    t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }));
  });
  assert.strictEqual(await page.isVisible('[data-error="details"]'), false, 'IME Enter triggered a submit');
  await page.press('[data-field="first-name"]', 'Enter');
  assert.strictEqual(await page.isVisible('[data-error="details"]'), true, 'plain Enter no longer submits');
  await context.close();
});
