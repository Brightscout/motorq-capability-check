/**
 * HubSpot Forms API submissions and the results email page (page: 'full-report').
 * Field names and hidden values come from the public definitions of Motorq's
 * HubSpot forms (portal 44687642).
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const H = require('../src/hubspot.js');

const EXPERT_FORM = '181fa58c-3817-4e24-9e0e-2429ac41fd64';
const FULL_REPORT_FORM = '8409589a-e0c5-411e-9a55-14aad0619df1';

const PAYLOAD = {
  firstName: 'Jane', lastName: 'Doe', fleetSize: '50-250', companyName: 'Acme Logistics',
  email: 'jane@acme.com', phone: '+1 (555) 123-4567', source: 'over-limit', vinCount: 1500,
  turnstileToken: 'tok',
};

/* ----- hubspot.js ----- */

test('over-limit and link go to the 1,000+ VINs form; the results email goes to the full report form', () => {
  assert.strictEqual(H.formKeyFor('over-limit'), 'expert');
  assert.strictEqual(H.formKeyFor('link'), 'expert');
  assert.strictEqual(H.formKeyFor(undefined), 'expert');
  assert.strictEqual(H.formKeyFor('email'), 'fullReport');
  assert.strictEqual(H.DEFAULTS.forms.expert.formId, EXPERT_FORM);
  assert.strictEqual(H.DEFAULTS.forms.fullReport.formId, FULL_REPORT_FORM);
});

test('buildBody maps to HubSpot field names, adds the hidden field and drops what the form does not have', () => {
  const body = H.buildBody(PAYLOAD, H.DEFAULTS.forms.expert, {});
  const fields = Object.fromEntries(body.fields.map((f) => [f.name, f.value]));
  assert.deepStrictEqual(fields, {
    firstname: 'Jane', lastname: 'Doe', email: 'jane@acme.com', company: 'Acme Logistics',
    fleet_size: '50-250', phone: '+1 (555) 123-4567',
    form_submission___pass_to_salesforce: '1,000+ VINs Capability Check Request from Self-Serve Capability Check Page',
  });
  assert.ok(body.fields.every((f) => f.objectTypeId === '0-1'));
  assert.strictEqual(body.context, undefined);
});

test('buildBody skips empty values and adds page context and the hubspotutk cookie', () => {
  const body = H.buildBody({ email: 'a@acme.com', phone: '' }, H.DEFAULTS.forms.fullReport, {
    uri: 'https://motorq.com/talk-to-an-expert', name: 'Talk to an Expert', cookie: 'a=1; hubspotutk=abc123; b=2',
  });
  assert.deepStrictEqual(body.fields.map((f) => f.name), ['email', 'form_submission___pass_to_salesforce']);
  assert.strictEqual(body.fields[1].value, 'Self-Serve Capability Check Full Report Request');
  assert.deepStrictEqual(body.context, { pageUri: 'https://motorq.com/talk-to-an-expert', pageName: 'Talk to an Expert', hutk: 'abc123' });
});

test('createSubmitter posts JSON to the Forms API v3 URL of the right form and passes the abort signal', async () => {
  const calls = [];
  const fakeFetch = (url, init) => { calls.push({ url, init }); return Promise.resolve({ status: 200 }); };
  const submit = H.createSubmitter({ fetch: fakeFetch });
  const signal = {};
  const res = await submit(PAYLOAD, { signal });
  await submit(Object.assign({}, PAYLOAD, { source: 'email' }));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(calls[0].url, `https://api.hsforms.com/submissions/v3/integration/submit/44687642/${EXPERT_FORM}`);
  assert.strictEqual(calls[1].url, `https://api.hsforms.com/submissions/v3/integration/submit/44687642/${FULL_REPORT_FORM}`);
  assert.strictEqual(calls[0].init.method, 'POST');
  assert.strictEqual(calls[0].init.headers['Content-Type'], 'application/json');
  assert.strictEqual(calls[0].init.signal, signal);
  assert.ok(JSON.parse(calls[0].init.body).fields.length > 0);
});

test('createSubmitter accepts another portal and form IDs', async () => {
  let url;
  const submit = H.createSubmitter({
    portalId: '1', forms: { fullReport: { formId: 'abc' } },
    fetch: (u) => { url = u; return Promise.resolve({ status: 200 }); },
  });
  await submit({ source: 'email' });
  assert.strictEqual(url, 'https://api.hsforms.com/submissions/v3/integration/submit/1/abc');
});

/* ----- Controller: expert name fields, HubSpot by default, full-report page ----- */

class FakeEl {
  constructor() { this.hidden = false; this.disabled = false; this.value = ''; this.textContent = ''; this.attrs = {}; this.listeners = {}; this.style = {}; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  focus() {}
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  fire(t) { (this.listeners[t] || []).forEach((fn) => fn({ preventDefault() {}, type: t })); }
  click() { if (!this.disabled) this.fire('click'); }
}

const SELECTORS = [
  '[data-step="vins"]', '[data-step="details"]', '[data-step="expert"]', '[data-step="success"]', '[data-step="expert-success"]',
  '[data-field="vins-text"]', '[data-action="vins-submit"]', '[data-error="vins"]',
  '[data-field="first-name"]', '[data-field="last-name"]', '[data-field="email"]', '[data-action="details-submit"]', '[data-error="details"]',
  '[data-field="expert-first-name"]', '[data-field="expert-last-name"]', '[data-field="fleet-size"]', '[data-field="company-name"]',
  '[data-field="company-email"]', '[data-field="phone-country"]', '[data-field="phone"]', '[data-action="expert-submit"]', '[data-error="expert"]',
  '[data-action="open-expert"]',
];

function buildDom() {
  const map = Object.fromEntries(SELECTORS.map((s) => [s, new FakeEl()]));
  return {
    map,
    tagName: 'DIV',
    querySelector: (s) => map[s] || null,
    querySelectorAll: (s) => (map[s] ? [map[s]] : []),
    addEventListener() {},
  };
}

function loadController() {
  global.window = global.window || {};
  window.MotorqVins = require('../src/vin-parser.js');
  window.MotorqEmail = require('../src/email-check.js');
  window.MotorqContact = require('../src/contact-check.js');
  window.MotorqHubSpot = H;
  const p = path.join(__dirname, '../src/form-controller.js');
  delete require.cache[require.resolve(p)];
  require(p);
  return window.MotorqCapCheck;
}

function fillExpert(dom, { names = true } = {}) {
  if (names) {
    dom.map['[data-field="expert-first-name"]'].value = 'Jane';
    dom.map['[data-field="expert-last-name"]'].value = 'Doe';
  }
  dom.map['[data-field="fleet-size"]'].value = '50-250';
  dom.map['[data-field="company-name"]'].value = 'Acme Logistics';
  dom.map['[data-field="company-email"]'].value = 'jane@acme.com';
  dom.map['[data-field="phone-country"]'].value = '+1';
  dom.map['[data-field="phone"]'].value = '(555) 123-4567';
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('fleet size options match the HubSpot form', () => {
  assert.deepStrictEqual(require('../src/contact-check.js').FLEET_SIZES,
    ['1-50', '50-250', '250-500', '500-1,000', 'More than 1,000']);
});

test('expert form: first and last name are required when the markup has them, and are sent', async () => {
  let sent;
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({ root: dom, history: false, submitExpert: (p) => { sent = p; return Promise.resolve(); } });
  dom.map['[data-action="open-expert"]'].click();
  fillExpert(dom, { names: false });
  dom.map['[data-action="expert-submit"]'].click();
  await tick();
  assert.strictEqual(sent, undefined);
  assert.strictEqual(dom.map['[data-error="expert"]'].textContent, Cap.MESSAGES.first_name_required);
  dom.map['[data-field="expert-first-name"]'].value = 'Jane';
  dom.map['[data-action="expert-submit"]'].click();
  await tick();
  assert.strictEqual(dom.map['[data-error="expert"]'].textContent, Cap.MESSAGES.last_name_required);
  dom.map['[data-field="expert-last-name"]'].value = ' Doe ';
  dom.map['[data-action="expert-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'expertSuccess');
  assert.deepStrictEqual(sent, {
    firstName: 'Jane', lastName: 'Doe', fleetSize: '50-250', companyName: 'Acme Logistics',
    email: 'jane@acme.com', phone: '+1 (555) 123-4567', source: 'link',
  });
});

test('expert link from step 2 copies first name, last name and email into the empty expert fields', async () => {
  const Cap = loadController();
  const dom = buildDom();
  Cap.init({ root: dom, history: false, submitExpert: () => Promise.resolve() });
  dom.map['[data-field="first-name"]'].value = 'Jane';
  dom.map['[data-field="last-name"]'].value = 'Doe';
  dom.map['[data-field="email"]'].value = 'jane@acme.com';
  dom.map['[data-field="expert-last-name"]'].value = 'Typed';
  dom.map['[data-action="open-expert"]'].click();
  assert.strictEqual(dom.map['[data-field="expert-first-name"]'].value, 'Jane');
  assert.strictEqual(dom.map['[data-field="expert-last-name"]'].value, 'Typed', 'overwrote what the user typed');
  assert.strictEqual(dom.map['[data-field="company-email"]'].value, 'jane@acme.com');
});

test('without submitExpert the controller posts to the HubSpot Forms API', async (t) => {
  const calls = [];
  const prevFetch = window.fetch;
  window.fetch = (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Promise.resolve({ status: 200 }); };
  t.after(() => { window.fetch = prevFetch; });
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({ root: dom, history: false });
  dom.map['[data-action="open-expert"]'].click();
  fillExpert(dom);
  dom.map['[data-action="expert-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'expertSuccess');
  assert.strictEqual(calls.length, 1);
  assert.ok(calls[0].url.endsWith(`/44687642/${EXPERT_FORM}`));
  assert.ok(calls[0].body.fields.some((f) => f.name === 'fleet_size' && f.value === '50-250'));
});

test('HubSpot 400 (e.g. a missing required field) shows the error and stays on the form', async (t) => {
  const prevFetch = window.fetch;
  window.fetch = () => Promise.resolve({ status: 400 });
  t.after(() => { window.fetch = prevFetch; });
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({ root: dom, history: false });
  dom.map['[data-action="open-expert"]'].click();
  fillExpert(dom);
  dom.map['[data-action="expert-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'expert');
  assert.strictEqual(dom.map['[data-error="expert"]'].textContent, Cap.MESSAGES.server);
});

test('full-report page: starts on the expert form, prefilled from the URL, and sends source "email"', async () => {
  let sent;
  const Cap = loadController();
  const dom = buildDom();
  const form = Cap.init({
    root: dom, page: 'full-report',
    search: '?firstname=Jos%C3%A9+Luis&lastname=O%27Brien&email=jose%40acme.com&utm_source=hs',
    submitExpert: (p) => { sent = p; return Promise.resolve(); },
  });
  assert.strictEqual(form.getState().step, 'expert');
  assert.strictEqual(dom.map['[data-step="expert"]'].hidden, false);
  assert.strictEqual(dom.map['[data-step="vins"]'].hidden, true);
  assert.strictEqual(dom.map['[data-field="expert-first-name"]'].value, 'José Luis');
  assert.strictEqual(dom.map['[data-field="expert-last-name"]'].value, "O'Brien");
  assert.strictEqual(dom.map['[data-field="company-email"]'].value, 'jose@acme.com');
  fillExpert(dom, { names: false });
  dom.map['[data-action="expert-submit"]'].click();
  await tick(); await tick();
  assert.strictEqual(form.getState().step, 'expertSuccess');
  assert.strictEqual(sent.source, 'email');
  assert.strictEqual(sent.firstName, 'José Luis');
  assert.strictEqual(sent.vinCount, undefined);
  assert.strictEqual(H.formKeyFor(sent.source), 'fullReport');
});

test('full-report page: no or malformed URL params leave the fields empty and do not throw', () => {
  const Cap = loadController();
  for (const search of ['', '?', '?firstname=%E0%A4%A&email=', '?email']) {
    const dom = buildDom();
    Cap.init({ root: dom, page: 'full-report', search, submitExpert: () => Promise.resolve() });
    assert.strictEqual(dom.map['[data-field="expert-first-name"]'].value, '');
    assert.strictEqual(dom.map['[data-field="company-email"]'].value, '');
  }
});
