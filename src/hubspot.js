/**
 * Motorq Capability Check: HubSpot Forms API submissions (Talk to an Expert).
 *
 * Exposes window.MotorqHubSpot in the browser and module.exports in Node (tests).
 *
 * The forms keep the site design: instead of HubSpot's embed script, the data
 * is posted to the Forms API v3 (no auth, CORS enabled):
 *   POST https://api.hsforms.com/submissions/v3/integration/submit/:portalId/:formId
 *
 * Which form gets the submission depends on how the user reached Talk to an
 * Expert (`source`):
 *   - 'over-limit' (more than 1,000 VINs) and 'link' (the link under the form)
 *     → the 1,000+ VINs form.
 *   - 'email' (the button in the results email) → the full report form.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    portalId: '44687642',
    endpoint: 'https://api.hsforms.com/submissions/v3/integration/submit/',
    forms: {
      // >1000 VINs form fill submission only
      expert: {
        formId: '181fa58c-3817-4e24-9e0e-2429ac41fd64',
        hidden: {
          form_submission___pass_to_salesforce:
            '1,000+ VINs Capability Check Request from Self-Serve Capability Check Page',
        },
      },
      // CTA from the results email: talk to an expert for the full report
      fullReport: {
        formId: '8409589a-e0c5-411e-9a55-14aad0619df1',
        hidden: {
          form_submission___pass_to_salesforce: 'Self-Serve Capability Check Full Report Request',
        },
      },
    },
  };

  // Payload key → HubSpot internal field name (contact properties).
  var FIELD_MAP = {
    firstName: 'firstname',
    lastName: 'lastname',
    email: 'email',
    companyName: 'company',
    fleetSize: 'fleet_size',
    phone: 'phone',
  };

  var CONTACT = '0-1';

  function formKeyFor(source) {
    return source === 'email' ? 'fullReport' : 'expert';
  }

  // The hubspotutk cookie links the submission to the visitor's HubSpot
  // tracking history, when the site runs the HubSpot tracking code.
  function readHutk(cookie) {
    var m = /(?:^|;\s*)hubspotutk=([^;]+)/.exec(cookie || '');
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * Builds the Forms API v3 body from a Talk to an Expert payload. Only the
   * fields the HubSpot form has are sent, plus the form's hidden fields.
   * `page` is { uri, name, cookie } (defaults to the current page).
   */
  function buildBody(payload, form, page) {
    var fields = [];
    Object.keys(FIELD_MAP).forEach(function (key) {
      var v = payload[key];
      if (v === undefined || v === null || v === '') return;
      fields.push({ objectTypeId: CONTACT, name: FIELD_MAP[key], value: String(v) });
    });
    var hidden = (form && form.hidden) || {};
    Object.keys(hidden).forEach(function (name) {
      fields.push({ objectTypeId: CONTACT, name: name, value: String(hidden[name]) });
    });

    var context = {};
    if (page && page.uri) context.pageUri = page.uri;
    if (page && page.name) context.pageName = page.name;
    var hutk = readHutk(page && page.cookie);
    if (hutk) context.hutk = hutk;

    var body = { fields: fields };
    if (Object.keys(context).length) body.context = context;
    return body;
  }

  function currentPage() {
    if (typeof document === 'undefined') return {};
    return {
      uri: root.location ? root.location.href : '',
      name: document.title || '',
      cookie: document.cookie || '',
    };
  }

  function mergeOptions(options) {
    options = options || {};
    var forms = {};
    Object.keys(DEFAULTS.forms).forEach(function (k) {
      forms[k] = Object.assign({}, DEFAULTS.forms[k], (options.forms || {})[k] || {});
    });
    return {
      portalId: options.portalId || DEFAULTS.portalId,
      endpoint: options.endpoint || DEFAULTS.endpoint,
      forms: forms,
      fetch: options.fetch,
    };
  }

  /**
   * Returns a `submitExpert(payload, { signal })` function for
   * MotorqCapCheck.init. Resolves with the fetch Response (200 is success).
   * options: { portalId, endpoint, forms: { expert: {formId, hidden}, fullReport: {...} }, fetch }
   */
  function createSubmitter(options) {
    var cfg = mergeOptions(options);
    return function (payload, opts) {
      var form = cfg.forms[formKeyFor(payload && payload.source)];
      var url = cfg.endpoint + encodeURIComponent(cfg.portalId) + '/' + encodeURIComponent(form.formId);
      // Looked up on each submit, so a fetch polyfill loaded later is used.
      var doFetch = cfg.fetch ||
        (typeof window !== 'undefined' && window.fetch) ||
        (typeof fetch === 'function' ? fetch : null);
      if (!doFetch) throw new Error('fetch is not available');
      return doFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody(payload || {}, form, currentPage())),
        signal: opts && opts.signal,
      });
    };
  }

  var api = {
    DEFAULTS: DEFAULTS,
    FIELD_MAP: FIELD_MAP,
    formKeyFor: formKeyFor,
    readHutk: readHutk,
    buildBody: buildBody,
    createSubmitter: createSubmitter,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqHubSpot = api;
})(typeof window !== 'undefined' ? window : this);
