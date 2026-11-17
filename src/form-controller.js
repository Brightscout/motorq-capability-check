/**
 * Motorq Capability Check: form controller (steps, tabs, live VIN count, Back,
 * VINs kept in memory, submits).
 *
 * Markup-agnostic: every element is found through configurable selectors, so it
 * can be wired to the Webflow markup by changing only the `selectors` object.
 *
 * Requires MotorqVins (vin-parser.js), MotorqEmail (email-check.js) and
 * MotorqContact (contact-check.js). Talk to an Expert posts to HubSpot through
 * MotorqHubSpot (hubspot.js) unless submitExpert is given.
 *
 * Usage:
 *   MotorqCapCheck.init({
 *     root: '#cap-check',
 *     page: 'full-report',                                     // optional: results email page
 *     submitCheck:  function (payload, opts) { return fetch(..., { signal: opts.signal }) },
 *     submitExpert: function (payload, opts) { ... },          // optional, replaces HubSpot
 *     hubspot: { portalId: '...', forms: { ... } },            // optional, see hubspot.js
 *     getTurnstileToken: function () { return turnstile.getResponse() },
 *     resetTurnstile: function () { turnstile.reset() },       // optional
 *     getExpertTurnstileToken: function () { ... },            // optional, never required
 *     resetExpertTurnstile: function () { ... },               // optional
 *     fleetSizes: ['1-25', ...],                               // optional
 *     phoneCountries: [{ value: '+1', label: 'US +1' }, ...],  // optional
 *     timeoutMs: 30000,                                        // optional, 0 = off
 *     history: true,                                           // optional
 *   });
 *
 * Submit functions return a promise. If it resolves with an object that has a
 * numeric `status` (like a fetch Response), only `successStatuses` (default
 * 200 and 202) count as success. A rejection or a thrown error is a failure.
 * After a failed submit the Turnstile widget is reset, because its tokens can
 * only be used once (resetTurnstile, or window.turnstile.reset() by default).
 */
(function (root) {
  'use strict';

  var DEFAULT_SELECTORS = {
    steps: {
      vins: '[data-step="vins"]',
      details: '[data-step="details"]',
      expert: '[data-step="expert"]',
      success: '[data-step="success"]',
      expertSuccess: '[data-step="expert-success"]',
    },
    // Step 1: VINs. Upload and Paste are tabs (data-tab="upload|paste") with
    // their panels (data-panel="upload|paste").
    tabs: '[data-tab]',
    panels: '[data-panel]',
    fileInput: '[data-field="file"]',
    fileName: '[data-file-name]',
    fileClear: '[data-action="clear-file"]',
    textarea: '[data-field="vins-text"]',
    textClear: '[data-action="clear-text"]',
    pasteButton: '[data-action="paste"]',
    vinsSubmit: '[data-action="vins-submit"]',
    vinsError: '[data-error="vins"]',
    vinCount: '[data-vin-count]',
    vinsFound: '[data-vins-found]',
    // Step 2: contact details
    firstName: '[data-field="first-name"]',
    lastName: '[data-field="last-name"]',
    email: '[data-field="email"]',
    detailsSubmit: '[data-action="details-submit"]',
    detailsError: '[data-error="details"]',
    // Talk to an Expert
    openExpert: '[data-action="open-expert"]',
    expertFirstName: '[data-field="expert-first-name"]',
    expertLastName: '[data-field="expert-last-name"]',
    fleetSize: '[data-field="fleet-size"]',
    companyName: '[data-field="company-name"]',
    companyEmail: '[data-field="company-email"]',
    phoneCountry: '[data-field="phone-country"]',
    phone: '[data-field="phone"]',
    expertSubmit: '[data-action="expert-submit"]',
    expertError: '[data-error="expert"]',
    // Shared
    back: '[data-action="back"]',
  };

  var MESSAGES = {
    invalid_input: 'Invalid input. Use only letters, numbers, commas, spaces or line breaks.',
    no_vins: 'No VINs detected.',
    unsupported_file: 'Unsupported file. Upload a .xlsx, .csv or .txt file.',
    file_read_error: "We couldn't read that file. Try again or paste your VINs.",
    first_name_required: 'Please enter your first name.',
    last_name_required: 'Please enter your last name.',
    email_required: 'Please enter your work email.',
    email_invalid: 'Please enter a valid email address.',
    email_personal: 'Please use your work email.',
    captcha: 'Please complete the verification.',
    fleet_size_required: 'Please select your fleet size.',
    company_name_required: 'Please enter your company name.',
    phone_country_required: 'Please select a country code.',
    phone_required: 'Please enter your phone number.',
    phone_invalid: 'Please enter a valid phone number.',
    server: 'Something went wrong. Please try again in a few minutes.',
  };

  // Wait this long after the user stops typing before counting pasted VINs.
  var LIVE_COUNT_DELAY = 300;

  function init(config) {
    var V = root.MotorqVins;
    var E = root.MotorqEmail;
    var C = root.MotorqContact;
    if (!V || !E || !C) throw new Error('vin-parser.js, email-check.js and contact-check.js must be loaded first');

    // 'full-report': the page the results email links to. Only the expert
    // form is shown, prefilled from the URL, and it posts to the full report
    // HubSpot form.
    var fullReport = config.page === 'full-report';

    // Talk to an Expert posts to the HubSpot Forms API (hubspot.js) unless a
    // custom submitExpert is given.
    var H = root.MotorqHubSpot;
    var expertSubmitter = config.submitExpert || (H ? H.createSubmitter(config.hubspot) : null);

    var sel = merge(DEFAULT_SELECTORS, config.selectors || {});
    var msg = Object.assign({}, MESSAGES, config.messages || {});
    var successStatuses = config.successStatuses || [200, 202];
    // 0, false, null or Infinity turn the timeout off. Browsers fire timers
    // over 2^31-1 ms right away, so those turn it off too.
    var timeoutMs = config.timeoutMs === undefined ? 30000 : Number(config.timeoutMs);
    var useTimeout = timeoutMs > 0 && timeoutMs <= 2147483647;
    var activeClass = config.activeClass || 'is-active';
    var container = typeof config.root === 'string' ? document.querySelector(config.root) : config.root;
    var $ = function (s) { return container.querySelector(s); };
    var $$ = function (s) { return Array.prototype.slice.call(container.querySelectorAll(s)); };

    // Each step gets a browser history entry, so the browser's Back button (or
    // Android's back gesture) goes to the previous step instead of leaving the page.
    var useHistory = !fullReport && config.history !== false && !!root.history &&
      typeof root.history.pushState === 'function' && typeof root.addEventListener === 'function';
    // Steps our own Back button asked the browser to go back to, in order.
    var expectedPops = [];
    var TERMINAL = { success: true, expertSuccess: true };

    // State. VINs live here, in memory, across steps.
    // - tab: active input tab ('upload' or 'paste'); null when the markup has
    //   no tabs (then a selected file wins over pasted text).
    // - live: the latest parse of each input, shown as "N VINs found" and
    //   reused on submit.
    // - vinsJob: increases when the input changes, so a slow file read that is
    //   no longer current gets discarded.
    // - expertSource / expertFrom: how and from which step the user reached
    //   Talk to an Expert.
    // - inputVersion / vinsVersion: the input changes since the VINs in
    //   memory were processed, so browser Forward can't reuse stale VINs.
    var state = {
      step: 'vins', history: [], vins: [], selectedFile: null, busy: false, vinsJob: 0,
      tab: null, live: { file: null, text: null }, expertSource: null, expertFrom: null,
      inputVersion: 0, vinsVersion: -1,
    };
    var liveTimer = null;

    var el = {
      fileInput: $(sel.fileInput), fileName: $(sel.fileName), fileClear: $(sel.fileClear),
      textarea: $(sel.textarea), textClear: $(sel.textClear), pasteButton: $(sel.pasteButton),
      vinsSubmit: $(sel.vinsSubmit), vinsError: $(sel.vinsError),
      firstName: $(sel.firstName), lastName: $(sel.lastName), email: $(sel.email),
      detailsSubmit: $(sel.detailsSubmit), detailsError: $(sel.detailsError),
      expertFirstName: $(sel.expertFirstName), expertLastName: $(sel.expertLastName),
      fleetSize: $(sel.fleetSize), companyName: $(sel.companyName), companyEmail: $(sel.companyEmail),
      phoneCountry: $(sel.phoneCountry), phone: $(sel.phone),
      expertSubmit: $(sel.expertSubmit), expertError: $(sel.expertError),
    };
    var tabs = $$(sel.tabs);
    var panels = $$(sel.panels);

    /* ----- Navigation ----- */

    function goTo(step, opts) {
      opts = opts || {};
      if (!opts.isBack) state.history.push(state.step);
      state.step = step;
      Object.keys(sel.steps).forEach(function (key) {
        setVisible($(sel.steps[key]), key === step);
      });
      if (!opts.initial) focusStep($(sel.steps[step]));
      if (useHistory && !opts.isBack && !opts.initial) {
        // Success screens replace the step 2 entry: browser Back from them
        // starts over instead of reopening a filled-in step 2.
        if (TERMINAL[step]) replaceEntry(step);
        else root.history.pushState({ motorqCapCheck: step }, '');
      }
      if (config.onStep) config.onStep(step, getState());
    }

    // Marks the current browser history entry with a step, keeping whatever
    // state other scripts (e.g. Webflow) stored in it.
    function replaceEntry(step) {
      var current = root.history.state;
      var next = current && typeof current === 'object' ? Object.assign({}, current) : {};
      next.motorqCapCheck = step;
      root.history.replaceState(next, '');
    }

    // Browser Back / Forward between our history entries.
    function onPopState(e) {
      var key = e.state && e.state.motorqCapCheck;

      // Our own Back button already showed the step; only check the entry.
      if (expectedPops.length) {
        var expected = expectedPops.shift();
        if (key !== expected) replaceEntry(expected);
        return;
      }

      // An entry the form didn't create (a #section link, another script):
      // stay on this step and remember it there.
      if (!key) { replaceEntry(state.step); return; }
      if (key === state.step) return;

      if (state.busy) {
        // Mid-submit: stay on this step.
        root.history.pushState({ motorqCapCheck: state.step }, '');
        return;
      }

      // Leaving a success screen starts over on step 1.
      if (TERMINAL[state.step]) {
        if (TERMINAL[key]) return;
        state.history = [];
        goTo('vins', { isBack: true });
        replaceEntry('vins');
        return;
      }

      // A success screen is never shown again from history (nothing was sent).
      if (TERMINAL[key]) { replaceEntry(state.step); return; }

      var target = key;
      var stale = state.inputVersion !== state.vinsVersion;
      if (target === 'details' && (!state.vins.length || stale)) target = 'vins';
      if (target === 'expert' && state.expertSource === 'over-limit' && stale) target = 'vins';
      if (target !== key) replaceEntry(target);
      if (target === state.step) return;

      var i = state.history.lastIndexOf(target);
      if (i !== -1) state.history = state.history.slice(0, i);  // back
      else state.history.push(state.step);                       // forward
      goTo(target, { isBack: true });
    }

    // Moves keyboard focus into the step just shown, so it isn't lost on a
    // button that was hidden.
    function focusStep(node) {
      if (!node || typeof node.querySelector !== 'function') return;
      var target = node.querySelector('input:not([type="hidden"]):not([disabled]), textarea, select');
      if (!target) {
        if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1');
        target = node;
      }
      if (typeof target.focus === 'function') target.focus();
    }

    function back() {
      if (!state.history.length || state.busy) return;
      var from = state.step;
      var to = state.history.pop();
      goTo(to, { isBack: true });
      // Keep the browser history in step with the form. If the current entry
      // isn't ours (the user followed a #section link), going back would land
      // somewhere else, so the entry is just relabeled.
      if (useHistory) {
        var current = expectedPops.length
          ? expectedPops[expectedPops.length - 1]
          : root.history.state && root.history.state.motorqCapCheck;
        if (current === from) {
          expectedPops.push(to);
          root.history.back();
        } else {
          replaceEntry(to);
        }
      }
    }

    // Any change to the step 1 input (file, text or tab).
    function inputChanged() {
      state.inputVersion++;
    }

    /* ----- Step 1: tabs ----- */

    function tabName(node) {
      return node.getAttribute('data-tab');
    }

    // Only one input mode is active. Switching keeps what was entered in the
    // other tab, but only the active tab is ever sent.
    function setTab(name) {
      if (!tabs.length) return;
      if (state.tab !== name) inputChanged();
      state.tab = name;
      tabs.forEach(function (t) {
        var active = tabName(t) === name;
        t.setAttribute('aria-selected', active ? 'true' : 'false');
        if (t.classList) t.classList.toggle(activeClass, active);
      });
      panels.forEach(function (p) {
        var active = p.getAttribute('data-panel') === name;
        setVisible(p, active);
        if (p.classList) p.classList.toggle(activeClass, active);
      });
      showError(el.vinsError, '');
      renderLive();
      refreshVinsButton();
    }

    // 'upload' or 'paste'. Without tabs, a selected file wins over pasted text.
    function activeMode() {
      if (state.tab) return state.tab;
      return state.selectedFile ? 'upload' : 'paste';
    }

    /* ----- Step 1: live VIN count ----- */

    function parseFileLive(file) {
      var entry = { file: file, result: null, promise: null };
      entry.promise = V.processFile(file).then(function (result) {
        entry.result = result;
        if (state.live.file === entry) renderLive();
        return result;
      });
      state.live.file = entry;
      return entry.promise;
    }

    function parseTextLive() {
      clearTimeout(liveTimer);
      liveTimer = null;
      var value = el.textarea ? el.textarea.value : '';
      state.live.text = value.trim() ? { value: value, result: V.processText(value) } : null;
      renderLive();
      return state.live.text;
    }

    function scheduleTextLive() {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(parseTextLive, LIVE_COUNT_DELAY);
    }

    // Shows "N VINs found" for the active input. Invalid or empty input hides
    // the count; errors only appear after pressing the button.
    function renderLive() {
      var entry = activeMode() === 'upload' ? state.live.file : state.live.text;
      var result = entry && entry.result;
      if (result && result.ok) setCount(result.count);
      $$(sel.vinsFound).forEach(function (n) { setVisible(n, !!(result && result.ok)); });
    }

    function setCount(count) {
      $$(sel.vinCount).forEach(function (n) { n.textContent = count.toLocaleString('en-US'); });
    }

    /* ----- Step 1: inputs and submit ----- */

    function refreshVinsButton() {
      var mode = activeMode();
      var hasFile = !!state.selectedFile;
      var hasText = !!(el.textarea && el.textarea.value.trim());
      var hasContent = state.tab ? (mode === 'upload' ? hasFile : hasText) : (hasFile || hasText);
      setDisabled(el.vinsSubmit, !hasContent || state.busy);
    }

    function setFile(file) {
      state.selectedFile = file || null;
      state.vinsJob++;
      inputChanged();
      if (el.fileName) el.fileName.textContent = file ? file.name : '';
      if (el.fileClear) el.fileClear.hidden = !file;
      if (!file && el.fileInput) el.fileInput.value = '';
      if (file) parseFileLive(file);
      else state.live.file = null;
      showError(el.vinsError, '');
      renderLive();
      refreshVinsButton();
    }

    function clearText() {
      if (el.textarea) el.textarea.value = '';
      clearTimeout(liveTimer);
      state.live.text = null;
      state.vinsJob++;
      onTextChanged();
      if (el.textarea && typeof el.textarea.focus === 'function') el.textarea.focus();
    }

    function onTextChanged() {
      inputChanged();
      showError(el.vinsError, '');
      if (el.textClear) el.textClear.hidden = !(el.textarea && el.textarea.value);
      renderLive();
      refreshVinsButton();
    }

    function submitVins() {
      // Buttons may be links or divs in Webflow, where `disabled` does nothing.
      if (state.busy) return Promise.resolve();
      showError(el.vinsError, '');
      setBusy(true);
      var jobId = ++state.vinsJob;

      // Only the active tab is used. The live result is reused when it is
      // still current, so the input isn't parsed twice.
      var job;
      if (activeMode() === 'upload') {
        var file = state.selectedFile;
        var live = state.live.file;
        if (!file) job = Promise.resolve({ ok: false, error: V.ERRORS.NO_VINS });
        else job = live && live.file === file ? live.promise : parseFileLive(file);
      } else {
        var text = el.textarea ? el.textarea.value : '';
        var liveText = state.live.text;
        var entry = liveText && liveText.value === text && !liveTimer ? liveText : parseTextLive();
        job = Promise.resolve(entry ? entry.result : V.processText(text));
      }

      return job.then(function (result) {
        setBusy(false);
        // The input was removed or replaced while it was being read: ignore it.
        if (jobId !== state.vinsJob) return { ok: false, discarded: true };
        if (!result.ok) {
          showError(el.vinsError, msg[result.error] || msg.server);
          return result;
        }
        state.vins = result.vins;
        state.vinsVersion = state.inputVersion;
        setCount(result.count);
        if (result.needsExpert) {
          state.expertSource = 'over-limit';
          state.expertFrom = 'vins';
          goTo('expert');
        } else {
          goTo('details');
        }
        return result;
      });
    }

    /* ----- Step 2: contact details + submit to Motorq ----- */

    function submitDetails() {
      if (state.busy) return Promise.resolve();
      showError(el.detailsError, '');
      var first = value(el.firstName);
      if (!first) return Promise.resolve(showError(el.detailsError, msg.first_name_required));
      var last = value(el.lastName);
      if (!last) return Promise.resolve(showError(el.detailsError, msg.last_name_required));

      var emailCheck = E.validateWorkEmail(el.email && el.email.value);
      if (!emailCheck.ok) return Promise.resolve(showError(el.detailsError, msg[emailCheck.error]));

      var token = '';
      try {
        token = config.getTurnstileToken ? config.getTurnstileToken() : '';
      } catch (e) { /* the Turnstile script didn't load (ad blocker, proxy) */ }
      if (!token) return Promise.resolve(showError(el.detailsError, msg.captcha));

      var payload = {
        fullName: C.joinName(first, last),
        email: emailCheck.email,
        vins: V.toApiString(state.vins),
        turnstileToken: token,
      };

      setBusy(true);
      return callSubmit(config.submitCheck, payload).then(function () {
        setBusy(false);
        // The token is spent: a new submit needs a new verification.
        resetTurnstile(config.resetTurnstile, true);
        goTo('success');
      }).catch(function (err) {
        setBusy(false);
        resetTurnstile(config.resetTurnstile, true);
        showError(el.detailsError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- Talk to an Expert ----- */

    // From the link under the form (step 1 or 2), with or without VINs.
    function openExpert() {
      if (state.busy || state.step === 'expert') return;
      state.expertSource = 'link';
      state.expertFrom = state.step;
      prefillExpertFromDetails();
      goTo('expert');
    }

    // Copies what the user already typed in step 2 into the empty expert
    // fields, so they don't type it twice.
    function prefillExpertFromDetails() {
      fillIfEmpty(el.expertFirstName, value(el.firstName));
      fillIfEmpty(el.expertLastName, value(el.lastName));
      fillIfEmpty(el.companyEmail, value(el.email));
    }

    // Results email page: first name, last name and email come in the URL
    // (?firstname=…&lastname=…&email=…), set by Motorq's backend.
    function prefillExpertFromUrl() {
      var params = readParams(config.search !== undefined ? config.search
        : (root.location ? root.location.search : ''));
      var names = Object.assign({ firstName: 'firstname', lastName: 'lastname', email: 'email' },
        config.prefillParams || {});
      fillIfEmpty(el.expertFirstName, params[names.firstName]);
      fillIfEmpty(el.expertLastName, params[names.lastName]);
      fillIfEmpty(el.companyEmail, params[names.email]);
    }

    // VINs the user has loaded: the processed ones, or (from step 1) the live
    // count of the active input.
    function currentVinCount() {
      if (state.expertSource === 'over-limit' || state.expertFrom === 'details') {
        return state.vins.length || null;
      }
      var entry = activeMode() === 'upload' ? state.live.file : state.live.text;
      return entry && entry.result && entry.result.ok ? entry.result.count : null;
    }

    function submitExpert() {
      if (state.busy) return Promise.resolve();
      showError(el.expertError, '');
      var fail = function (key) { return Promise.resolve(showError(el.expertError, msg[key])); };

      // Name fields are only checked when the markup has them.
      var firstName = value(el.expertFirstName);
      if (el.expertFirstName && !firstName) return fail('first_name_required');
      var lastName = value(el.expertLastName);
      if (el.expertLastName && !lastName) return fail('last_name_required');
      var fleetSize = value(el.fleetSize);
      if (!fleetSize) return fail('fleet_size_required');
      var companyName = value(el.companyName);
      if (!companyName) return fail('company_name_required');
      var emailCheck = E.validateWorkEmail(el.companyEmail && el.companyEmail.value);
      if (!emailCheck.ok) return fail(emailCheck.error);
      var country = value(el.phoneCountry);
      if (!country) return fail('phone_country_required');
      var phoneCheck = C.validatePhone(el.phone && el.phone.value);
      if (!phoneCheck.ok) return fail(phoneCheck.error);

      var payload = {};
      if (firstName) payload.firstName = firstName;
      if (lastName) payload.lastName = lastName;
      Object.assign(payload, {
        fleetSize: fleetSize,
        companyName: companyName,
        email: emailCheck.email,
        phone: country + ' ' + phoneCheck.phone,
        source: state.expertSource || 'link',
      });
      var vinCount = currentVinCount();
      if (vinCount) payload.vinCount = vinCount;

      // Optional: HubSpot can't verify it, so it never blocks the submit.
      var token = '';
      try {
        token = config.getExpertTurnstileToken ? config.getExpertTurnstileToken() : '';
      } catch (e) { /* not loaded */ }
      if (token) payload.turnstileToken = token;

      setBusy(true);
      return callSubmit(expertSubmitter, payload).then(function () {
        setBusy(false);
        resetTurnstile(config.resetExpertTurnstile, false);
        goTo('expertSuccess');
      }).catch(function (err) {
        setBusy(false);
        resetTurnstile(config.resetExpertTurnstile, false);
        showError(el.expertError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- Helpers ----- */

    // Runs a submit function. A thrown error, a rejection, no answer within
    // timeoutMs or an HTTP status outside successStatuses all end up as a
    // rejected promise. The function gets { signal } as its second argument:
    // passing it to fetch() cancels the request on timeout, so a late answer
    // can't create a second lead when the user retries.
    function callSubmit(fn, payload) {
      var controller = typeof AbortController === 'function' ? new AbortController() : null;
      return new Promise(function (resolve, reject) {
        var timer = useTimeout ? setTimeout(function () {
          if (controller) controller.abort();
          var err = new Error('Request timed out');
          err.timeout = true;
          reject(err);
        }, timeoutMs) : null;
        new Promise(function (res) {
          if (typeof fn !== 'function') throw new Error('Submit function is not configured');
          res(fn(payload, { signal: controller ? controller.signal : undefined }));
        }).then(
          function (res) { clearTimeout(timer); resolve(res); },
          function (err) { clearTimeout(timer); reject(err); }
        );
      }).then(function (res) {
        if (res && typeof res.status === 'number' && successStatuses.indexOf(res.status) === -1) {
          var err = new Error('HTTP ' + res.status);
          err.status = res.status;
          err.response = res;
          throw err;
        }
        return res;
      });
    }

    // Turnstile tokens can only be used once: get a new one after a failure.
    // The step 2 widget falls back to window.turnstile.reset().
    function resetTurnstile(customReset, useGlobal) {
      try {
        if (customReset) customReset();
        else if (useGlobal && root.turnstile && typeof root.turnstile.reset === 'function') root.turnstile.reset();
      } catch (e) { /* a broken widget must not hide the error message */ }
    }

    function value(node) {
      return (node && node.value || '').trim();
    }

    function fillIfEmpty(node, text) {
      if (node && text && !value(node)) node.value = text;
    }

    // "?a=1&b=x%20y" → { a: '1', b: 'x y' }. "+" is a space, as in form URLs.
    function readParams(search) {
      var out = {};
      String(search || '').replace(/^\?/, '').split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i === -1 ? pair : pair.slice(0, i);
        var v = i === -1 ? '' : pair.slice(i + 1);
        try {
          k = decodeURIComponent(k.replace(/\+/g, ' '));
          v = decodeURIComponent(v.replace(/\+/g, ' '));
        } catch (e) { return; /* malformed escape: skip it */ }
        if (!(k in out)) out[k] = v.trim();
      });
      return out;
    }

    // Fills a <select> with the configured options, unless the markup already
    // has real options (more than a placeholder).
    function fillSelect(select, options) {
      if (!select || !select.options || typeof document === 'undefined') return;
      if (select.options.length > 1) return;
      options.forEach(function (opt) {
        var o = document.createElement('option');
        o.value = typeof opt === 'string' ? opt : opt.value;
        o.textContent = typeof opt === 'string' ? opt : opt.label;
        select.appendChild(o);
      });
    }

    // Site CSS (e.g. a Webflow class with display:flex) can override the
    // hidden attribute, so the inline style is set as well.
    function setVisible(node, visible) {
      if (!node) return;
      node.hidden = !visible;
      if (node.style) node.style.display = visible ? '' : 'none';
    }

    function showError(node, text) {
      if (!node) return;
      node.textContent = text || '';
      node.hidden = !text;
    }

    function setBusy(busy) {
      state.busy = busy;
      [el.vinsSubmit, el.detailsSubmit, el.expertSubmit].forEach(function (b) {
        if (b) b.setAttribute('aria-busy', busy ? 'true' : 'false');
      });
      setDisabled(el.detailsSubmit, busy);
      setDisabled(el.expertSubmit, busy);
      refreshVinsButton();
    }

    // `disabled` only works on real buttons; aria-disabled also tells screen
    // readers when the "button" is a Webflow link.
    function setDisabled(node, disabled) {
      if (!node) return;
      node.disabled = disabled;
      node.setAttribute('aria-disabled', disabled ? 'true' : 'false');
    }

    function getState() {
      return {
        step: state.step, tab: activeMode(), vinCount: state.vins.length, vins: state.vins.slice(),
        expertSource: state.expertSource,
      };
    }

    /* ----- Events ----- */

    function on(node, evt, fn) {
      if (node && typeof node.addEventListener === 'function') node.addEventListener(evt, fn);
    }
    function prevent(fn) { return function (e) { e.preventDefault(); fn(); }; }

    tabs.forEach(function (t) { on(t, 'click', prevent(function () { setTab(tabName(t)); })); });
    on(el.fileInput, 'change', function () { setFile(el.fileInput.files[0]); });
    on(el.fileClear, 'click', prevent(function () { setFile(null); }));
    on(el.textClear, 'click', prevent(clearText));
    on(el.textarea, 'input', function () { onTextChanged(); scheduleTextLive(); });
    // Paste doesn't read the clipboard: it moves focus to the text field so the
    // user pastes there themselves (on mobile this opens the keyboard).
    on(el.pasteButton, 'click', prevent(function () {
      if (tabs.length) setTab('paste');
      if (el.textarea && typeof el.textarea.focus === 'function') el.textarea.focus();
    }));
    on(el.vinsSubmit, 'click', prevent(submitVins));
    on(el.detailsSubmit, 'click', prevent(submitDetails));
    on(el.expertSubmit, 'click', prevent(submitExpert));
    $$(sel.openExpert).forEach(function (a) { on(a, 'click', prevent(openExpert)); });
    $$(sel.back).forEach(function (b) { on(b, 'click', prevent(back)); });

    // Error messages are announced by screen readers.
    [el.vinsError, el.detailsError, el.expertError].forEach(function (node) {
      if (node && !node.getAttribute('role') && !node.getAttribute('aria-live')) {
        node.setAttribute('role', 'alert');
      }
    });

    // Inside a <form> (e.g. a Webflow Form Block), a <button> without a type
    // submits the form, and Enter "clicks" the first one (the hidden Remove
    // button). Make them plain buttons, handle Enter ourselves and never let
    // the form post anywhere.
    $$('button').forEach(function (b) {
      if (!b.hasAttribute('type')) b.setAttribute('type', 'button');
    });
    on(container, 'keydown', function (e) {
      var t = e.target;
      if (e.key !== 'Enter' || !t || t.tagName !== 'INPUT') return;
      // Enter that confirms a Japanese/Chinese/Korean input candidate.
      if (e.isComposing || e.keyCode === 229) return;
      if (/^(checkbox|radio|file|button|submit)$/i.test(t.type)) return;
      e.preventDefault();
      if (state.step === 'details') submitDetails();
      else if (state.step === 'expert') submitExpert();
    });
    var form = container.tagName === 'FORM' ? container
      : (typeof container.closest === 'function' ? container.closest('form') : null);
    on(form, 'submit', function (e) {
      e.preventDefault();
      e.stopPropagation();
    });

    if (useHistory) {
      root.addEventListener('popstate', onPopState);
      // After a reload the entry may still say "details" or "success": the
      // form always starts on step 1.
      replaceEntry('vins');
    }

    fillSelect(el.fleetSize, config.fleetSizes || C.FLEET_SIZES);
    fillSelect(el.phoneCountry, config.phoneCountries || C.PHONE_COUNTRIES);

    // Initial tab: the one marked aria-selected="true", or the first one.
    if (tabs.length) {
      var selected = tabs.filter(function (t) { return t.getAttribute('aria-selected') === 'true'; })[0];
      setTab(tabName(selected || tabs[0]));
    }

    if (fullReport) {
      state.expertSource = 'email';
      prefillExpertFromUrl();
      goTo('expert', { isBack: true, initial: true });
    } else {
      goTo('vins', { isBack: true, initial: true });
    }
    renderLive();
    refreshVinsButton();

    return { getState: getState, goTo: goTo, back: back, setTab: setTab, openExpert: openExpert };
  }

  function merge(base, extra) {
    var out = Object.assign({}, base, extra);
    out.steps = Object.assign({}, base.steps, extra.steps || {});
    return out;
  }

  root.MotorqCapCheck = { init: init, MESSAGES: MESSAGES, LIVE_COUNT_DELAY: LIVE_COUNT_DELAY };
})(window);
