/**
 * Adversarial QA tests for the Motorq Capability Check.
 *
 * Every test here encodes a client requirement (the "Req" number in its name)
 * and fails if the code breaks it. Test names start with the QA finding ID.
 *
 * The controller tests use a tiny fake DOM (no extra dependencies), so they run
 * with plain `node --test`.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const XLSX = require('xlsx');
const V = require('../src/vin-parser.js');
const E = require('../src/email-check.js');

const A = '1HGCM82633A004352';
const B = '5YJSA1E26HF000337';
const C = 'WVWZZZ1JZXW000001';

function xlsxBuffer(sheets, bookType = 'xlsx') {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  return XLSX.write(wb, { type: 'array', bookType });
}

function fakeFile(name, bytes) {
  return {
    name,
    arrayBuffer: async () => bytes,
    // Same semantics as Blob.text(): always decodes as UTF-8.
    text: async () => new Blob([bytes]).text(),
  };
}

// processFile() reads SheetJS from the IIFE's `root` (window in the browser).
// In CommonJS `root` is the module's original exports object, so load a fresh
// copy with a browser-like `window` that has XLSX, as on the real page.
async function withXlsxGlobal(fn) {
  const hadWindow = 'window' in global;
  const prev = global.window;
  global.window = Object.assign(prev || {}, { XLSX });
  const p = require.resolve('../src/vin-parser.js');
  delete require.cache[p];
  const Vb = require(p);
  delete require.cache[p];
  try { return await fn(Vb); } finally { if (!hadWindow) delete global.window; }
}

/* =====================================================================
 * VIN parsing (requirements 2, 3, 5, 6)
 * ===================================================================== */

test('F04 [Req 5/6] CSV with several columns: only the VINs are sent (non-VIN columns are not VINs)', () => {
  const csv = `Make,VIN,Model\nHonda,${A},Accord\nTesla,${B},Model S`;
  const r = V.processText(csv);
  assert.strictEqual(r.ok, true);
  // Actual: ["HONDA","1HG…","ACCORD","TESLA","5YJ…","MODEL","S"] (count 7 instead of 2)
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('F04b [Req 6] CSV with extra columns must not inflate the count and push a small fleet to Talk to an Expert', () => {
  const rows = ['VIN,Make,Model,Plate'];
  for (let i = 0; i < 400; i++) rows.push(`TEST${String(i).padStart(13, '0')},MAKE${i},MODEL${i},PLATE${i}`);
  const r = V.processText(rows.join('\n'));
  assert.strictEqual(r.count, 400);
  assert.strictEqual(r.needsExpert, false);
});

test('F05 [Req 5] xlsx: a header like "Province" before the VIN column must not be picked as the VIN column', () => {
  const rows = V.readWorkbookRows(xlsxBuffer({ Fleet: [['Province', 'VIN'], ['Ontario', A], ['Quebec', B]] }), XLSX);
  const r = V.processRows(rows);
  // Actual: ["ONTARIO","QUEBEC"]: the real VINs are dropped.
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('F05b [Req 5] xlsx: a "Driving Region" header before the VIN column must not hide the VINs', () => {
  const rows = V.readWorkbookRows(xlsxBuffer({ Fleet: [['Driving Region', 'VIN Number'], ['North', A]] }), XLSX);
  assert.deepStrictEqual(V.processRows(rows).vins, [A]);
});

test('F06 [Req 5] header variants without the word "VIN" are removed', () => {
  for (const header of ['vehicle id', 'Vehicle Identification Number', 'Chassis Number', 'Serial Number']) {
    const r = V.processText(`${header}\n${A}\n${B}`);
    assert.deepStrictEqual(r.vins, [A, B], `header "${header}" was sent as VINs: ${JSON.stringify(r.vins)}`);
  }
});

test('F07 [Req 5] header variants with punctuation ("VIN #", "VIN No.", "VIN_Number") are cleaned, not rejected', () => {
  for (const header of ['VIN #', 'VIN No.', 'VIN_Number', 'VIN:']) {
    const r = V.processText(`${header}\n${A}`);
    assert.strictEqual(r.ok, true, `"${header}" header → ${r.error}`);
    assert.deepStrictEqual(r.vins, [A]);
  }
});

test('F07b [Req 5] the same "VIN #" header works in .xlsx, so CSV and XLSX behave inconsistently', () => {
  const xlsx = V.processRows(V.readWorkbookRows(xlsxBuffer({ S: [['VIN #'], [A]] }), XLSX));
  const csv = V.processText(`VIN #\n${A}`);
  assert.strictEqual(xlsx.ok, true);
  assert.deepStrictEqual(csv, xlsx);
});

test('F08 [Req 5] a title row above the header: header text is not sent as VINs', () => {
  const r = V.processText(`Fleet export\nVIN\n${A}`);
  // Actual: ["FLEET","EXPORT","VIN","1HG…"]
  assert.deepStrictEqual(r.vins, [A]);
});

test('F08b [Req 5] xlsx with a dated title row above the header is not rejected as Invalid input', () => {
  const rows = V.readWorkbookRows(xlsxBuffer({ S: [['Fleet report 2026-11-01'], ['VIN'], [A]] }), XLSX);
  const r = V.processRows(rows);
  assert.strictEqual(r.ok, true, `got ${r.error}`);
  assert.deepStrictEqual(r.vins, [A]);
});

test('F09 [Req 5/6] a first DATA row is not dropped just because a cell contains the letters "vin"', () => {
  const r = V.processText(`${A},Driving school\n${B}`);
  // Actual: the whole first row (including a real VIN) is silently dropped.
  assert.ok(r.vins.includes(A), `VIN ${A} was lost: ${JSON.stringify(r.vins)}`);
});

// Decision (16/11): VINs are found by their pattern. Rows above the first real
// VIN are kept only if they look like a VIN (11–17 letters/numbers with a
// digit); anything else there ("KEVIN", titles, headers) is treated as a title.
test('F09b [Req 5] an invalid VIN above the first real VIN is still sent', () => {
  const r = V.processText(`1HGCM82633A00435\n${A}`);
  assert.deepStrictEqual(r.vins, ['1HGCM82633A00435', A]);
});

test('F10 [Req 2/5] xlsx: VINs stored as numbers are not turned into scientific notation and rejected', () => {
  const rows = V.readWorkbookRows(xlsxBuffer({ S: [['VIN'], [12345678901234567], [A]] }), XLSX);
  const r = V.processRows(rows);
  // Actual: "1.23457E+16" → Invalid input for the whole file.
  assert.strictEqual(r.ok, true, `got ${r.error} ${JSON.stringify(r.invalidChars)}`);
  assert.strictEqual(r.count, 2);
});

// Decision (16/11): only the first sheet is read, with the same VIN column logic.
test('F11 [Req 2, decided] xlsx with several sheets: only the first sheet is read, using its VIN column', async () => {
  const buf = xlsxBuffer({ Fleet: [['Make', 'VIN'], ['Honda', A]], Other: [['VIN'], [B]] });
  const r = V.processRows(V.readWorkbookRows(buf, XLSX));
  assert.deepStrictEqual(r.vins, [A]);
});

test('F12 [Req 2, Needs decision] an .xls workbook renamed to .xlsx is rejected like .xls', async () => {
  const xls = xlsxBuffer({ S: [['VIN'], [A]] }, 'xls');
  const r = await withXlsxGlobal((Vb) => Vb.processFile(fakeFile('fleet.xlsx', xls)));
  // Actual: accepted and parsed (SheetJS reads BIFF8 regardless of extension).
  assert.strictEqual(r.error, V.ERRORS.UNSUPPORTED_FILE);
});

test('F13 [Req 2] a corrupted .xlsx reports a file read error, not "Invalid input"', async () => {
  const garbage = new Uint8Array(4096);
  let s = 7; // deterministic LCG noise
  for (let i = 0; i < garbage.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; garbage[i] = (s >> 16) & 255; }
  const r = await withXlsxGlobal((Vb) => Vb.processFile(fakeFile('fleet.xlsx', garbage)));
  assert.strictEqual(r.error, V.ERRORS.FILE_READ);
});

// Decision (16/11): tabs are accepted (copying cells from Excel adds them).
test('F14 [Req 3, decided] tabs are accepted as separators', () => {
  const r = V.processText(`${A}\t${B}`);
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('F15 [Req 3/5, Needs decision] a non-breaking space (copied from web/Excel Online) is treated as a space', () => {
  const r = V.processText(`${A} ${B}`);
  assert.strictEqual(r.ok, true, `got ${r.error}`);
  assert.deepStrictEqual(r.vins, [A, B]);
});

/* =====================================================================
 * Work email (requirement 7)
 * ===================================================================== */

test('F17 [Req 7] common free / personal providers are blocked', () => {
  const missed = ['duck.com', 'foxmail.com', 'ya.ru', 'bigpond.com', 'posteo.de', 'mailbox.org',
    'mailinator.com', 'guerrillamail.com', 'yeah.net', 'optusnet.com.au', 'xtra.co.nz']
    .filter((d) => E.validateWorkEmail(`someone@${d}`).ok);
  assert.deepStrictEqual(missed, [], 'not blocked: ' + missed.join(', '));
});

test('F18 [Req 7, Needs decision] company domains built from generic words are not blocked as personal', () => {
  const blocked = ['aim.io', 'mail.ai', 'live.tv', 'inbox.ai', 'zoho.in']
    .filter((d) => E.validateWorkEmail(`ops@${d}`).error === E.ERRORS.PERSONAL);
  // zoho.in is personal-ish, but aim.io / mail.ai / live.tv / inbox.ai can be real companies.
  assert.deepStrictEqual(blocked.filter((d) => d !== 'zoho.in'), [], 'blocked: ' + blocked.join(', '));
});

test('F19 [Req 7, Needs decision] internationalized (IDN) work domains are accepted', () => {
  assert.strictEqual(E.validateWorkEmail('jane@müller-logistik.de').ok, true);
});

test('F20 [Req 8] HTML/script payloads are not accepted as a valid email', () => {
  const r = E.validateWorkEmail('<img/src=x/onerror=alert(1)>@acme.com');
  assert.strictEqual(r.ok, false);
});

/* =====================================================================
 * Form controller (requirements 1, 9, 10, 12) with a minimal fake DOM
 * ===================================================================== */

class FakeEl {
  constructor(tag) { this.tag = tag; this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.files = []; this.attrs = {}; this.listeners = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  focus() { FakeEl.focused = this; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, type: t })); }
  click() { if (!this.disabled) this.fire('click'); }
}

function buildDom() {
  const map = {
    '[data-step="vins"]': new FakeEl('section'),
    '[data-step="details"]': new FakeEl('section'),
    '[data-step="expert"]': new FakeEl('section'),
    '[data-step="success"]': new FakeEl('section'),
    '[data-step="expert-success"]': new FakeEl('section'),
    '[data-field="file"]': new FakeEl('input'),
    '[data-file-name]': new FakeEl('span'),
    '[data-action="clear-file"]': new FakeEl('button'),
    '[data-field="vins-text"]': new FakeEl('textarea'),
    '[data-action="paste"]': new FakeEl('button'),
    '[data-action="vins-submit"]': new FakeEl('button'),
    '[data-error="vins"]': new FakeEl('div'),
    '[data-field="full-name"]': new FakeEl('input'),
    '[data-field="email"]': new FakeEl('input'),
    '[data-action="details-submit"]': new FakeEl('button'),
    '[data-error="details"]': new FakeEl('div'),
    '[data-field="expert-name"]': new FakeEl('input'),
    '[data-field="expert-email"]': new FakeEl('input'),
    '[data-action="expert-submit"]': new FakeEl('button'),
    '[data-error="expert"]': new FakeEl('div'),
  };
  const backs = [new FakeEl('button'), new FakeEl('button')];
  const counts = [new FakeEl('span')];
  return {
    map, backs,
    querySelector: (s) => map[s] || (s === '[data-action="back"]' ? backs[0] : null),
    querySelectorAll: (s) => (s === '[data-action="back"]' ? backs : s === '[data-vin-count]' ? counts : (map[s] ? [map[s]] : [])),
  };
}

function loadController() {
  global.window = global.window || {};
  window.MotorqVins = V;
  window.MotorqEmail = E;
  const p = path.join(__dirname, '../src/form-controller.js');
  delete require.cache[require.resolve(p)];
  require(p);
  return window.MotorqCapCheck;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function toDetails(dom, form, text = `${A}\n${B}`) {
  dom.map['[data-field="vins-text"]'].value = text;
  dom.map['[data-field="vins-text"]'].fire('input');
  dom.map['[data-action="vins-submit"]'].click();
  await tick();
  assert.strictEqual(form.getState().step, 'details');
  dom.map['[data-field="full-name"]'].value = 'Jane Doe';
  dom.map['[data-field="email"]'].value = 'jane@acme.com';
}

test('F01 [Req 12] an HTTP error response (fetch resolves with ok:false / 500) does NOT show the success screen', async () => {
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({
    root: dom,
    getTurnstileToken: () => 'tok',
    // What the README's example does: return fetch(...). fetch resolves on 4xx/5xx.
    submitCheck: () => Promise.resolve({ ok: false, status: 500 }),
    submitExpert: () => Promise.resolve(),
  });
  await toDetails(dom, form);
  dom.map['[data-action="details-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'details', 'user was sent to the success screen on a 500');
  assert.ok(dom.map['[data-error="details"]'].textContent, 'no error message shown');
});

test('F01b [Req 12] only 200/202 count as success (e.g. 400 Bad Request is an error)', async () => {
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({
    root: dom, getTurnstileToken: () => 'tok',
    submitCheck: () => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'bad vins' }) }),
    submitExpert: () => Promise.resolve(),
  });
  await toDetails(dom, form);
  dom.map['[data-action="details-submit"]'].click();
  await tick(); await tick();
  assert.notStrictEqual(form.getState().step, 'success');
});

test('F02 [Req 12/7] after an API failure, a retry can succeed (Turnstile tokens are single-use and must be reset)', async (t) => {
  // Emulates Cloudflare: getResponse() keeps returning the same token until reset();
  // siteverify rejects a token that was already used.
  const ts = { n: 0, current: 'tok-0', used: new Set(), reset() { this.current = 'tok-' + (++this.n); } };
  let calls = 0;
  const Cap = loadController();
  const dom = buildDom();
  window.turnstile = ts; // the real widget's global
  t.after(() => { delete window.turnstile; });
  const form = Cap.init({
    root: dom,
    getTurnstileToken: () => ts.current,
    submitCheck: (p) => {
      calls++;
      if (ts.used.has(p.turnstileToken)) return Promise.reject(new Error('timeout-or-duplicate'));
      ts.used.add(p.turnstileToken);
      if (calls === 1) return Promise.reject(new Error('502 from Motorq'));
      return Promise.resolve({ ok: true, status: 202 });
    },
    submitExpert: () => Promise.resolve(),
  });
  await toDetails(dom, form);
  dom.map['[data-action="details-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'details');
  dom.map['[data-action="details-submit"]'].click(); // user retries
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'success', 'retry re-sent the already-spent Turnstile token');
});

test('F03 [Req 12] a submit handler that throws synchronously does not leave the form stuck (busy forever)', async () => {
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({
    root: dom, getTurnstileToken: () => 'tok',
    submitCheck: () => { throw new Error('endpoint not configured'); },
    submitExpert: () => Promise.resolve(),
  });
  await toDetails(dom, form);
  try { dom.map['[data-action="details-submit"]'].click(); } catch (e) { /* escapes the handler */ }
  await tick();
  assert.strictEqual(dom.map['[data-action="details-submit"]'].disabled, false, 'submit button permanently disabled');
  assert.ok(dom.map['[data-error="details"]'].textContent, 'no error shown');
  dom.backs[0].click();
  assert.strictEqual(form.getState().step, 'vins', 'Back is blocked forever');
});

// Decision (16/11): when there is a file and pasted text, the file wins.
test('F16 [Req 1, decided] file AND pasted text: the file is used', async () => {
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({ root: dom, getTurnstileToken: () => 'tok', submitCheck: () => Promise.resolve(), submitExpert: () => Promise.resolve() });
  const input = dom.map['[data-field="file"]'];
  input.files = [fakeFile('fleet.csv', Buffer.from(`VIN\n${A}\n`))];
  input.fire('change');
  dom.map['[data-field="vins-text"]'].value = `${B}\n${C}`;
  dom.map['[data-field="vins-text"]'].fire('input');
  dom.map['[data-action="vins-submit"]'].click();
  await tick(); await tick();
  const s = form.getState();
  assert.strictEqual(s.step, 'details');
  assert.deepStrictEqual(s.vins, [A]);
});

// Pending: depends on the fields of the client's HubSpot form.
test('F21 [Req 9, Needs decision] Talk to an Expert sends only name and company email', { todo: 'waiting for the HubSpot form fields' }, async () => {
  let sent;
  const Cap = loadController();
  const dom = buildDom();
  const big = Array.from({ length: 1001 }, (_, i) => 'TEST' + String(i).padStart(13, '0')).join('\n');
  const form = Cap.init({ root: dom, getTurnstileToken: () => 'tok', submitCheck: () => Promise.resolve(), submitExpert: (p) => { sent = p; return Promise.resolve(); } });
  dom.map['[data-field="vins-text"]'].value = big;
  dom.map['[data-field="vins-text"]'].fire('input');
  dom.map['[data-action="vins-submit"]'].click();
  await tick();
  assert.strictEqual(form.getState().step, 'expert');
  dom.map['[data-field="expert-name"]'].value = 'Jane';
  dom.map['[data-field="expert-email"]'].value = 'jane@acme.com';
  dom.map['[data-action="expert-submit"]'].click();
  await tick();
  assert.deepStrictEqual(Object.keys(sent).sort(), ['email', 'fullName']);
});

// Decision (16/11): Paste does not read the clipboard. The user pastes into the
// text field themselves; the button only moves focus there.
test('F22 [Req 1, decided] Paste button focuses the text field and does not read the clipboard', async () => {
  const Cap = loadController();
  const dom = buildDom();
  const nav = global.navigator;
  let read = false;
  Object.defineProperty(global, 'navigator', { value: { clipboard: { readText: () => { read = true; return Promise.resolve(A); } } }, configurable: true });
  try {
    Cap.init({ root: dom, getTurnstileToken: () => 'tok', submitCheck: () => Promise.resolve(), submitExpert: () => Promise.resolve() });
    dom.map['[data-field="vins-text"]'].value = B;
    dom.map['[data-action="paste"]'].click();
    await tick(); await tick();
    assert.strictEqual(read, false, 'the clipboard was read');
    assert.strictEqual(FakeEl.focused, dom.map['[data-field="vins-text"]']);
    assert.strictEqual(dom.map['[data-field="vins-text"]'].value, B, 'existing text was replaced');
  } finally {
    Object.defineProperty(global, 'navigator', { value: nav, configurable: true });
  }
});

test('F23 [a11y] error containers are announced to screen readers (role=alert or aria-live)', async () => {
  const Cap = loadController();
  const dom = buildDom();
  Cap.init({ root: dom, getTurnstileToken: () => 'tok', submitCheck: () => Promise.resolve(), submitExpert: () => Promise.resolve() });
  dom.map['[data-field="vins-text"]'].value = `${A};${B}`;
  dom.map['[data-field="vins-text"]'].fire('input');
  dom.map['[data-action="vins-submit"]'].click();
  await tick();
  const err = dom.map['[data-error="vins"]'];
  assert.ok(err.textContent);
  assert.ok(err.getAttribute('role') === 'alert' || err.getAttribute('aria-live'), 'error is not announced');
});
