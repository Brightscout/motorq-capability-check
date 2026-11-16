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
 *     resetTurnstile: function () { turnstile.reset() },       // optional
 *     timeoutMs: 30000,                                        // optional
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
    var successStatuses = config.successStatuses || [200, 202];
    var timeoutMs = config.timeoutMs || 30000;
    var container = typeof config.root === 'string' ? document.querySelector(config.root) : config.root;
    var $ = function (s) { return container.querySelector(s); };
    var $$ = function (s) { return Array.prototype.slice.call(container.querySelectorAll(s)); };

    // Each step gets a browser history entry, so the browser's Back button (or
    // Android's back gesture) goes to the previous step instead of leaving the page.
    var useHistory = config.history !== false && !!root.history &&
      typeof root.history.pushState === 'function' && typeof root.addEventListener === 'function';
    var ignoreNextPop = false;

    // State. VINs live here, in memory, across steps.
    // vinsJob: increases when the input changes, so a slow file read that is
    // no longer current gets discarded.
    var state = { step: 'vins', history: [], vins: [], selectedFile: null, busy: false, vinsJob: 0 };

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
      opts = opts || {};
      if (!opts.isBack) state.history.push(state.step);
      state.step = step;
      Object.keys(sel.steps).forEach(function (key) {
        var node = $(sel.steps[key]);
        if (!node) return;
        var hide = key !== step;
        node.hidden = hide;
        // Site CSS (e.g. a Webflow class with display:flex) can override the
        // hidden attribute, so the inline style is set as well.
        if (node.style) node.style.display = hide ? 'none' : '';
      });
      if (!opts.initial) focusStep($(sel.steps[step]));
      if (useHistory && !opts.isBack && !opts.initial) {
        root.history.pushState({ motorqCapCheck: step }, '');
      }
      if (config.onStep) config.onStep(step, getState());
    }

    // Browser Back / Forward between our history entries.
    function onPopState(e) {
      if (ignoreNextPop) { ignoreNextPop = false; return; }
      var target = (e.state && e.state.motorqCapCheck) || 'vins';
      if (target === state.step) return;
      if (state.busy) {
        // Mid-submit: stay on this step.
        root.history.pushState({ motorqCapCheck: state.step }, '');
        return;
      }
      if ((target === 'details' || target === 'expert') && !state.vins.length) target = 'vins';

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
      goTo(state.history.pop(), { isBack: true });
      // Keep the browser history in step with the form.
      if (useHistory) {
        ignoreNextPop = true;
        root.history.back();
      }
    }

    /* ----- Step 1: VINs ----- */

    function refreshVinsButton() {
      var hasContent = !!state.selectedFile || !!(el.textarea && el.textarea.value.trim());
      setDisabled(el.vinsSubmit, !hasContent || state.busy);
    }

    function setFile(file) {
      state.selectedFile = file || null;
      state.vinsJob++;
      if (el.fileName) el.fileName.textContent = file ? file.name : '';
      if (el.fileClear) el.fileClear.hidden = !file;
      if (!file && el.fileInput) el.fileInput.value = '';
      showError(el.vinsError, '');
      refreshVinsButton();
    }

    function submitVins() {
      // Buttons may be links or divs in Webflow, where `disabled` does nothing.
      if (state.busy) return Promise.resolve();
      showError(el.vinsError, '');
      setBusy(true);
      var jobId = ++state.vinsJob;

      // Use the selected file if there is one; otherwise, the pasted text.
      var job = state.selectedFile
        ? V.processFile(state.selectedFile)
        : Promise.resolve(V.processText(el.textarea ? el.textarea.value : ''));

      return job.then(function (result) {
        setBusy(false);
        // The file was removed or replaced while it was being read: ignore it.
        if (jobId !== state.vinsJob) return { ok: false, discarded: true };
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
      if (state.busy) return Promise.resolve();
      showError(el.detailsError, '');
      var fullName = (el.fullName && el.fullName.value || '').trim();
      if (!fullName) return Promise.resolve(showError(el.detailsError, msg.name_required));

      var emailCheck = E.validateWorkEmail(el.email && el.email.value);
      if (!emailCheck.ok) return Promise.resolve(showError(el.detailsError, msg[emailCheck.error]));

      var token = '';
      try {
        token = config.getTurnstileToken ? config.getTurnstileToken() : '';
      } catch (e) { /* the Turnstile script didn't load (ad blocker, proxy) */ }
      if (!token) return Promise.resolve(showError(el.detailsError, msg.captcha));

      var payload = {
        fullName: fullName,
        email: emailCheck.email,
        vins: V.toApiString(state.vins),
        turnstileToken: token,
      };

      setBusy(true);
      return callSubmit(config.submitCheck, payload).then(function () {
        setBusy(false);
        goTo('success');
      }).catch(function (err) {
        setBusy(false);
        resetTurnstile();
        showError(el.detailsError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- More than 1,000 VINs: Talk to an Expert ----- */

    function submitExpert() {
      if (state.busy) return Promise.resolve();
      showError(el.expertError, '');
      var name = (el.expertName && el.expertName.value || '').trim();
      if (!name) return Promise.resolve(showError(el.expertError, msg.name_required));

      var emailCheck = E.validateWorkEmail(el.expertEmail && el.expertEmail.value);
      if (!emailCheck.ok) return Promise.resolve(showError(el.expertError, msg[emailCheck.error]));

      var payload = { fullName: name, email: emailCheck.email, vinCount: state.vins.length };

      setBusy(true);
      return callSubmit(config.submitExpert, payload).then(function () {
        setBusy(false);
        goTo('expertSuccess');
      }).catch(function (err) {
        setBusy(false);
        showError(el.expertError, (err && err.userMessage) || msg.server);
        if (config.onError) config.onError(err);
      });
    }

    /* ----- Helpers ----- */

    // Runs a submit function. A thrown error, a rejection, no answer within
    // timeoutMs or an HTTP status outside successStatuses all end up as a
    // rejected promise.
    function callSubmit(fn, payload) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () {
          var err = new Error('Request timed out');
          err.timeout = true;
          reject(err);
        }, timeoutMs);
        new Promise(function (res) {
          if (typeof fn !== 'function') throw new Error('Submit function is not configured');
          res(fn(payload));
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
    function resetTurnstile() {
      try {
        if (config.resetTurnstile) config.resetTurnstile();
        else if (root.turnstile && typeof root.turnstile.reset === 'function') root.turnstile.reset();
      } catch (e) { /* a broken widget must not hide the error message */ }
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
      return { step: state.step, vinCount: state.vins.length, vins: state.vins.slice() };
    }

    /* ----- Events ----- */

    function on(node, evt, fn) {
      if (node && typeof node.addEventListener === 'function') node.addEventListener(evt, fn);
    }
    function prevent(fn) { return function (e) { e.preventDefault(); fn(); }; }

    on(el.fileInput, 'change', function () { setFile(el.fileInput.files[0]); });
    on(el.fileClear, 'click', prevent(function () { setFile(null); }));
    on(el.textarea, 'input', function () { showError(el.vinsError, ''); refreshVinsButton(); });
    // Paste doesn't read the clipboard: it moves focus to the text field so the
    // user pastes there themselves (on mobile this opens the keyboard).
    on(el.pasteButton, 'click', prevent(function () {
      if (el.textarea && typeof el.textarea.focus === 'function') el.textarea.focus();
    }));
    on(el.vinsSubmit, 'click', prevent(submitVins));
    on(el.detailsSubmit, 'click', prevent(submitDetails));
    on(el.expertSubmit, 'click', prevent(submitExpert));
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

    if (useHistory) root.addEventListener('popstate', onPopState);

    goTo('vins', { isBack: true, initial: true });
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
