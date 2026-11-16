/**
 * Motorq Capability Check: form controller (steps, Back, VINs kept in memory).
 *
 * Markup-agnostic: every element is found through configurable selectors, so it
 * can be wired to the Webflow markup by changing only the `selectors` object.
 *
 * Requires MotorqVins (vin-parser.js) and MotorqEmail (email-check.js).
 *
 * Usage:
 *   MotorqCapCheck.init({
 *     root: '#cap-check',
 *     submitCheck:  function (payload) { return fetch(...) },  // Motorq API
 *     submitExpert: function (payload) { return fetch(...) },  // HubSpot Forms API
 *     getTurnstileToken: function () { return turnstile.getResponse() },
 *   });
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
    // Step 1: VINs
    fileInput: '[data-field="file"]',
    fileName: '[data-file-name]',
    fileClear: '[data-action="clear-file"]',
    textarea: '[data-field="vins-text"]',
    pasteButton: '[data-action="paste"]',
    vinsSubmit: '[data-action="vins-submit"]',
    vinsError: '[data-error="vins"]',
    vinCount: '[data-vin-count]',
    // Step 2: contact details
    fullName: '[data-field="full-name"]',
    email: '[data-field="email"]',
    detailsSubmit: '[data-action="details-submit"]',
    detailsError: '[data-error="details"]',
    // Talk to an Expert
    expertName: '[data-field="expert-name"]',
    expertEmail: '[data-field="expert-email"]',
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
    name_required: 'Please enter your full name.',
    email_required: 'Please enter your work email.',
    email_invalid: 'Please enter a valid email address.',
    email_personal: 'Please use your work email.',
    captcha: 'Please complete the verification.',
    server: 'Something went wrong. Please try again in a few minutes.',
  };

  function init(config) {
    var V = root.MotorqVins;
    var E = root.MotorqEmail;
    if (!V || !E) throw new Error('vin-parser.js and email-check.js must be loaded first');

    var sel = merge(DEFAULT_SELECTORS, config.selectors || {});
    var msg = Object.assign({}, MESSAGES, config.messages || {});
    var container = typeof config.root === 'string' ? document.querySelector(config.root) : config.root;
    var $ = function (s) { return container.querySelector(s); };
    var $$ = function (s) { return Array.prototype.slice.call(container.querySelectorAll(s)); };

    // State. VINs live here, in memory, across steps.
    var state = { step: 'vins', history: [], vins: [], selectedFile: null, busy: false };

    var el = {
      fileInput: $(sel.fileInput), fileName: $(sel.fileName), fileClear: $(sel.fileClear),
      textarea: $(sel.textarea), pasteButton: $(sel.pasteButton),
      vinsSubmit: $(sel.vinsSubmit), vinsError: $(sel.vinsError),
      fullName: $(sel.fullName), email: $(sel.email),
      detailsSubmit: $(sel.detailsSubmit), detailsError: $(sel.detailsError),
      expertName: $(sel.expertName), expertEmail: $(sel.expertEmail),
      expertSubmit: $(sel.expertSubmit), expertError: $(sel.expertError),
    };

    /* ----- Navigation ----- */

    function goTo(step, opts) {
      if (!(opts && opts.isBack)) state.history.push(state.step);
      state.step = step;
      Object.keys(sel.steps).forEach(function (key) {
        var node = $(sel.steps[key]);
        if (node) node.hidden = key !== step;
      });
      if (config.onStep) config.onStep(step, getState());
    }

    function back() {
      if (!state.history.length || state.busy) return;
      goTo(state.history.pop(), { isBack: true });
    }

    /* ----- Step 1: VINs ----- */

    function refreshVinsButton() {
      var hasContent = !!state.selectedFile || !!(el.textarea && el.textarea.value.trim());
      if (el.vinsSubmit) el.vinsSubmit.disabled = !hasContent || state.busy;
    }

    function setFile(file) {
      state.selectedFile = file || null;
      if (el.fileName) el.fileName.textContent = file ? file.name : '';
      if (el.fileClear) el.fileClear.hidden = !file;
      if (!file && el.fileInput) el.fileInput.value = '';
      showError(el.vinsError, '');
      refreshVinsButton();
    }

    function submitVins() {
      showError(el.vinsError, '');
      setBusy(true);

      // Use the selected file if there is one; otherwise, the pasted text.
      var job = state.selectedFile
        ? V.processFile(state.selectedFile)
        : Promise.resolve(V.processText(el.textarea ? el.textarea.value : ''));

      return job.then(function (result) {
        setBusy(false);
        if (!result.ok) {
          showError(el.vinsError, msg[result.error] || msg.server);
          return result;
        }
        state.vins = result.vins;
        $$(sel.vinCount).forEach(function (n) { n.textContent = result.count.toLocaleString('en-US'); });
        goTo(result.needsExpert ? 'expert' : 'details');
        return result;
      });
    }

    /* ----- Step 2: contact details + submit to Motorq ----- */

    function submitDetails() {
      showError(el.detailsError, '');
      var fullName = (el.fullName && el.fullName.value || '').trim();
      if (!fullName) return Promise.resolve(showError(el.detailsError, msg.name_required));

      var emailCheck = E.validateWorkEmail(el.email && el.email.value);
      if (!emailCheck.ok) return Promise.resolve(showError(el.detailsError, msg[emailCheck.error]));

      var token = config.getTurnstileToken ? config.getTurnstileToken() : '';
      if (!token) return Promise.resolve(showError(el.detailsError, msg.captcha));

      var payload = {
        fullName: fullName,
        email: emailCheck.email,
        vins: V.toApiString(state.vins),
        turnstileToken: token,
      };

      setBusy(true);
      return Promise.resolve(config.submitCheck(payload)).then(function () {
        setBusy(false);
        goTo('success');
      }).catch(function (err) {
        setBusy(false);
        showError(el.detailsError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- More than 1,000 VINs: Talk to an Expert ----- */

    function submitExpert() {
      showError(el.expertError, '');
      var name = (el.expertName && el.expertName.value || '').trim();
      if (!name) return Promise.resolve(showError(el.expertError, msg.name_required));

      var emailCheck = E.validateWorkEmail(el.expertEmail && el.expertEmail.value);
      if (!emailCheck.ok) return Promise.resolve(showError(el.expertError, msg[emailCheck.error]));

      var payload = { fullName: name, email: emailCheck.email, vinCount: state.vins.length };

      setBusy(true);
      return Promise.resolve(config.submitExpert(payload)).then(function () {
        setBusy(false);
        goTo('expertSuccess');
      }).catch(function (err) {
        setBusy(false);
        showError(el.expertError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- Helpers ----- */

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
      if (el.detailsSubmit) el.detailsSubmit.disabled = busy;
      if (el.expertSubmit) el.expertSubmit.disabled = busy;
      refreshVinsButton();
    }

    function getState() {
      return { step: state.step, vinCount: state.vins.length, vins: state.vins.slice() };
    }

    /* ----- Events ----- */

    function on(node, evt, fn) { if (node) node.addEventListener(evt, fn); }
    function prevent(fn) { return function (e) { e.preventDefault(); fn(); }; }

    on(el.fileInput, 'change', function () { setFile(el.fileInput.files[0]); });
    on(el.fileClear, 'click', prevent(function () { setFile(null); }));
    on(el.textarea, 'input', function () { showError(el.vinsError, ''); refreshVinsButton(); });
    on(el.pasteButton, 'click', prevent(function () {
      if (!navigator.clipboard || !navigator.clipboard.readText) return;
      navigator.clipboard.readText().then(function (text) {
        el.textarea.value = text;
        refreshVinsButton();
      }).catch(function () { /* clipboard permission denied */ });
    }));
    on(el.vinsSubmit, 'click', prevent(submitVins));
    on(el.detailsSubmit, 'click', prevent(submitDetails));
    on(el.expertSubmit, 'click', prevent(submitExpert));
    $$(sel.back).forEach(function (b) { on(b, 'click', prevent(back)); });

    goTo('vins', { isBack: true });
    refreshVinsButton();

    return { getState: getState, goTo: goTo, back: back };
  }

  function merge(base, extra) {
    var out = Object.assign({}, base, extra);
    out.steps = Object.assign({}, base.steps, extra.steps || {});
    return out;
  }

  root.MotorqCapCheck = { init: init, MESSAGES: MESSAGES };
})(window);
