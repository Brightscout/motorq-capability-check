/*! Motorq Capability Check v1.1.0 | Brightscout */
/* src/vin-parser.js */
/**
 * Motorq Capability Check: VIN reading and processing in the browser.
 *
 * Pure logic, no DOM. Flow:
 *   file (.xlsx / .csv / .txt) or pasted text
 *     → grid of rows and cells (cells split by commas or tabs)
 *     → find the first real VIN by its pattern (the "anchor")
 *     → keep the anchor's column, plus any other column that is mostly VINs,
 *       from the anchor row down (titles and headers above it are dropped)
 *     → allowed-characters check on what will be sent   ("Invalid input")
 *     → any VINs?                                      ("No VINs detected")
 *     → remove duplicates and count
 *     → more than 1,000? → Talk to an Expert
 *
 * If no real VIN is found anywhere, every cell is sent except a header row.
 * Invalid VINs inside the VIN columns are still sent (Motorq requirement).
 *
 * .xlsx files require SheetJS to be loaded first (window.XLSX).
 * Exposes window.MotorqVins in the browser and module.exports in Node (tests).
 */
(function (root) {
  'use strict';

  var CONFIG = {
    MAX_VINS: 1000,
    // Pending confirmation from Motorq (dedupe vs. send everything).
    DEDUPE: true,
    ACCEPTED_EXTENSIONS: ['xlsx', 'csv', 'txt'],
  };

  var ERRORS = {
    INVALID_INPUT: 'invalid_input',
    NO_VINS: 'no_vins',
    UNSUPPORTED_FILE: 'unsupported_file',
    FILE_READ: 'file_read_error',
  };

  // What we send must be letters and numbers. Spaces, commas, tabs and line
  // breaks are separators (tabs come from copying several cells in Excel).
  var TOKEN_ALLOWED = /^[A-Za-z0-9]+$/;
  var CELL_SEPARATORS = /[,\t]/;
  var TOKEN_SEPARATORS = /[\s,]+/;
  // A modern VIN: 17 characters, no I, O or Q, at least one digit.
  var VIN_PATTERN = /^(?=[^0-9]*[0-9])[A-HJ-NPR-Z0-9]{17}$/i;
  // Older or mistyped VINs: 11 to 17 letters and numbers, at least one digit.
  var VIN_CANDIDATE = /^(?=[^0-9]*[0-9])[A-Za-z0-9]{11,17}$/;
  // Header cells, only used when there is no real VIN to anchor on.
  var HEADER_CELL = /(^|[^a-z])(vins?|vehicle|identification|chassis|serial)([^a-z]|$)/i;
  var VIN_HEADER = /(^|[^a-z])vins?([^a-z]|$)/i;

  /* ---------- Text ---------- */

  function normalizeText(text) {
    return String(text == null ? '' : text)
      .replace(/[​-‍⁠﻿]/g, '')  // BOM and zero-width characters
      .replace(/[   ]/g, ' ')        // non-breaking spaces
      .replace(/\r\n?/g, '\n');
  }

  /** Validates and processes pasted text or the contents of a CSV/TXT file. */
  function processText(text, options) {
    var rows = normalizeText(text).split('\n').map(function (line) {
      return line.split(CELL_SEPARATORS).map(trim);
    });
    return extract(rows, options);
  }

  /* ---------- Rows (XLSX) ---------- */

  /** Processes rows already extracted from a spreadsheet (array of cell arrays). */
  function processRows(rawRows, options) {
    var rows = (rawRows || []).map(function (row) {
      return (row || []).map(function (cell) {
        return cell == null ? '' : trim(normalizeText(cell));
      });
    });
    return extract(rows, options);
  }

  /* ---------- Extraction ---------- */

  function extract(rows, options) {
    var opts = Object.assign({}, CONFIG, options || {});
    var anchor = findAnchor(rows);
    var cells = anchor ? cellsFromAnchor(rows, anchor) : cellsWithoutAnchor(rows);

    var tokens = [];
    cells.forEach(function (cell) {
      tokensOf(cell).forEach(function (t) { tokens.push(t); });
    });

    var bad = tokens.filter(function (t) { return !TOKEN_ALLOWED.test(t); });
    if (bad.length) return fail(ERRORS.INVALID_INPUT, { invalidChars: findInvalidChars(bad.join('')) });

    return finish(tokens, opts);
  }

  /** First cell (row by row, left to right) that holds a real VIN. */
  function findAnchor(rows) {
    for (var r = 0; r < rows.length; r++) {
      for (var c = 0; c < rows[r].length; c++) {
        if (tokensOf(rows[r][c]).some(isVin)) return { row: r, col: c };
      }
    }
    return null;
  }

  /**
   * Keeps the anchor's column and any other column where most cells (from the
   * anchor row down) are VINs. Rows above the anchor are kept only if they look
   * like VINs too, so titles and headers are dropped.
   */
  function cellsFromAnchor(rows, anchor) {
    var cols = selectColumns(rows, anchor);
    var out = [];
    rows.forEach(function (row, r) {
      cols.forEach(function (c) {
        var cell = row[c];
        if (!cell) return;
        if (r < anchor.row && !looksLikeVinCell(cell)) return;
        out.push(cell);
      });
    });
    return out;
  }

  function selectColumns(rows, anchor) {
    var width = 0;
    rows.forEach(function (row) { width = Math.max(width, row.length); });

    var cols = [];
    for (var c = 0; c < width; c++) {
      if (c === anchor.col) { cols.push(c); continue; }
      var filled = 0;
      var vins = 0;
      for (var r = anchor.row; r < rows.length; r++) {
        var cell = rows[r][c];
        if (!cell) continue;
        filled++;
        if (tokensOf(cell).some(isVin)) vins++;
      }
      if (vins > 0 && vins * 2 >= filled) cols.push(c);
    }
    return cols;
  }

  /** No real VIN anywhere: send every cell, minus a header row. */
  function cellsWithoutAnchor(rows) {
    rows = rows.filter(function (row) { return row.some(Boolean); });
    var first = rows[0] || [];
    var isHeader = first.some(function (cell) {
      return HEADER_CELL.test(cell) && !looksLikeVinCell(cell);
    });
    if (!isHeader) return flatten(rows);

    var vinCol = -1;
    first.forEach(function (cell, i) { if (vinCol === -1 && VIN_HEADER.test(cell)) vinCol = i; });
    var body = rows.slice(1);
    if (vinCol === -1) return flatten(body);
    return body.map(function (row) { return row[vinCol] || ''; }).filter(Boolean);
  }

  /* ---------- Files ---------- */

  function getExtension(name) {
    var match = /\.([^.]+)$/.exec(name || '');
    return match ? match[1].toLowerCase() : '';
  }

  function isAcceptedFile(file) {
    return CONFIG.ACCEPTED_EXTENSIONS.indexOf(getExtension(file && file.name)) !== -1;
  }

  /** Reads a File from the input. Resolves to the same result shape as processText. */
  function processFile(file, options) {
    var ext = getExtension(file && file.name);

    if (CONFIG.ACCEPTED_EXTENSIONS.indexOf(ext) === -1) {
      return Promise.resolve(fail(ERRORS.UNSUPPORTED_FILE, { extension: ext }));
    }

    if (ext === 'xlsx') {
      return file.arrayBuffer().then(function (buffer) {
        return processRows(readWorkbookRows(buffer), options);
      }).catch(function (err) {
        return fail((err && err.code) || ERRORS.FILE_READ, { cause: err && err.message });
      });
    }

    return file.text().then(function (text) {
      return processText(text, options);
    }).catch(function (err) {
      return fail(ERRORS.FILE_READ, { cause: err && err.message });
    });
  }

  /**
   * First sheet of the .xlsx file as an array of rows.
   * Checks the file's content, not just its name: a real .xlsx is a zip file.
   * An old .xls renamed to .xlsx is rejected as unsupported; anything else that
   * isn't a readable .xlsx is a file read error.
   */
  function readWorkbookRows(buffer, xlsxLib) {
    var XLSX = xlsxLib || root.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) is not loaded');

    var bytes = new Uint8Array(buffer);
    var isZip = bytes[0] === 0x50 && bytes[1] === 0x4B;
    // Old Office format (.xls). Password-protected .xlsx files use it too.
    var isOle = bytes[0] === 0xD0 && bytes[1] === 0xCF && bytes[2] === 0x11 && bytes[3] === 0xE0;
    if (!isZip && !isOle) throw codedError(ERRORS.FILE_READ, 'Not an .xlsx file');

    var workbook = XLSX.read(bytes, { type: 'array' });
    if (isOle) throw codedError(ERRORS.UNSUPPORTED_FILE, 'Legacy .xls file');

    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    // raw: keep numbers as numbers (no "1.23E+16" formatting).
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  }

  /* ---------- Helpers ---------- */

  function trim(value) {
    return String(value).trim();
  }

  function tokensOf(cell) {
    return cell ? String(cell).split(TOKEN_SEPARATORS).filter(Boolean) : [];
  }

  function isVin(token) {
    return VIN_PATTERN.test(token);
  }

  function looksLikeVinCell(cell) {
    var tokens = tokensOf(cell);
    return tokens.length > 0 && tokens.every(function (t) { return VIN_CANDIDATE.test(t); });
  }

  function flatten(rows) {
    var out = [];
    rows.forEach(function (row) { row.forEach(function (cell) { if (cell) out.push(cell); }); });
    return out;
  }

  function codedError(code, message) {
    var err = new Error(message);
    err.code = code;
    return err;
  }

  function finish(tokens, opts) {
    var all = tokens.map(function (t) { return t.toUpperCase(); });

    if (!all.length) return fail(ERRORS.NO_VINS);

    var vins = opts.DEDUPE ? unique(all) : all;

    return {
      ok: true,
      vins: vins,
      count: vins.length,
      totalFound: all.length,
      duplicatesRemoved: all.length - unique(all).length,
      needsExpert: vins.length > opts.MAX_VINS,
    };
  }

  function unique(list) {
    var seen = Object.create(null);
    return list.filter(function (item) {
      if (seen[item]) return false;
      seen[item] = true;
      return true;
    });
  }

  function findInvalidChars(text) {
    var found = text.replace(/[A-Za-z0-9]/g, '');
    return unique(Array.from(found)).slice(0, 10);
  }

  function fail(code, extra) {
    return Object.assign({ ok: false, error: code }, extra || {});
  }

  /** String format expected by the Motorq API: VIN1,VIN2,VIN3 (no spaces). */
  function toApiString(vins) {
    return vins.join(',');
  }

  var api = {
    CONFIG: CONFIG,
    ERRORS: ERRORS,
    processText: processText,
    processRows: processRows,
    processFile: processFile,
    readWorkbookRows: readWorkbookRows,
    isAcceptedFile: isAcceptedFile,
    toApiString: toApiString,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqVins = api;
})(typeof window !== 'undefined' ? window : this);

/* src/email-check.js */
/**
 * Motorq Capability Check: work email validation (step 2).
 *
 * Blocks personal emails using a short list of free email providers.
 * Providers with country-specific domains (yahoo.co.uk, hotmail.com.ar, gmx.de…)
 * are covered by a pattern so every TLD doesn't need to be listed.
 *
 * Exposes window.MotorqEmail in the browser and module.exports in Node (tests).
 */
(function (root) {
  'use strict';

  var ERRORS = {
    REQUIRED: 'email_required',
    INVALID: 'email_invalid',
    PERSONAL: 'email_personal',
  };

  // Basic format: name@domain.tld (strict validation happens in the backend).
  // The name part only allows the characters valid in an unquoted address, so
  // HTML like "<img ...>" is rejected. Domains may use accented letters (IDN).
  var EMAIL_FORMAT = /^[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@([\p{L}\p{N}-]+\.)+(\p{L}{2,}|xn--[a-z0-9-]+)$/iu;

  // Providers that exist under many country domains.
  // Matches provider + .com / .net / .org / .<country> / .co.<country> / .com.<country>
  var PROVIDERS_ANY_TLD = [
    'gmail', 'googlemail', 'yahoo', 'ymail', 'rocketmail',
    'hotmail', 'outlook', 'live', 'msn', 'windowslive',
    'aol', 'aim', 'gmx', 'yandex', 'mail', 'zoho', 'inbox',
  ];
  // Only real country domains where these providers operate. Generic ones that
  // companies use (.io, .ai, .tv, .co, .me…) are left out on purpose.
  var COUNTRIES = [
    'ar', 'at', 'au', 'be', 'bg', 'br', 'by', 'ca', 'ch', 'cl', 'cn', 'cz', 'de',
    'dk', 'ee', 'es', 'fi', 'fr', 'gr', 'hk', 'hr', 'hu', 'id', 'ie', 'il', 'in',
    'it', 'jp', 'kr', 'kz', 'lt', 'lu', 'lv', 'mx', 'my', 'nl', 'no', 'nz', 'pe',
    'ph', 'pl', 'pt', 'ro', 'rs', 'ru', 'se', 'sg', 'si', 'sk', 'th', 'tr', 'tw',
    'ua', 'uk', 'uy', 've', 'vn', 'za',
  ].join('|');
  var ANY_TLD_PATTERN = new RegExp(
    '^(' + PROVIDERS_ANY_TLD.join('|') + ')\\.(com|net|org|' + COUNTRIES + '|com?\\.(' + COUNTRIES + '))$'
  );

  // Specific domains.
  var DOMAINS = [
    // Apple
    'icloud.com', 'me.com', 'mac.com',
    // Privacy-focused
    'proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me', 'tutanota.com',
    'tutanota.de', 'tuta.io', 'tuta.com', 'hushmail.com', 'mailfence.com',
    // Other global providers and ISPs
    'fastmail.com', 'fastmail.fm', 'hey.com', 'mail.com', 'email.com',
    'usa.com', 'att.net', 'sbcglobal.net', 'bellsouth.net', 'comcast.net',
    'verizon.net', 'cox.net', 'charter.net', 'earthlink.net', 'juno.com',
    'optonline.net', 'frontier.com', 'rogers.com', 'shaw.ca', 'sympatico.ca',
    // Europe
    'web.de', 'freenet.de', 't-online.de', 'orange.fr', 'wanadoo.fr',
    'free.fr', 'laposte.net', 'sfr.fr', 'libero.it', 'virgilio.it',
    'tiscali.it', 'btinternet.com', 'sky.com', 'virginmedia.com',
    'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl',
    'rambler.ru', 'list.ru', 'bk.ru', 'ukr.net',
    // Asia
    'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com', 'aliyun.com',
    'naver.com', 'daum.net', 'hanmail.net', 'rediffmail.com',
    'foxmail.com', 'yeah.net', '139.com', '188.com', 'sina.cn',
    // Russia, Europe and Oceania (more)
    'ya.ru', 'posteo.de', 'mailbox.org', 'duck.com',
    'bigpond.com', 'bigpond.net.au', 'optusnet.com.au', 'xtra.co.nz',
    // Latam
    'uol.com.br', 'bol.com.br', 'terra.com.br', 'ig.com.br',
    'fibertel.com.ar', 'speedy.com.ar', 'arnet.com.ar', 'prodigy.net.mx',
    // Disposable addresses
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com',
    'yopmail.com', '10minutemail.com', 'temp-mail.org', 'trashmail.com',
    'getnada.com', 'maildrop.cc', 'dispostable.com',
  ];

  var DOMAIN_SET = Object.create(null);
  DOMAINS.forEach(function (d) { DOMAIN_SET[d] = true; });

  function getDomain(email) {
    var at = email.lastIndexOf('@');
    return at === -1 ? '' : email.slice(at + 1);
  }

  function isPersonalDomain(domain) {
    domain = String(domain || '').toLowerCase().trim();
    return !!DOMAIN_SET[domain] || ANY_TLD_PATTERN.test(domain);
  }

  /** Returns { ok: true, email } or { ok: false, error }. */
  function validateWorkEmail(value) {
    var email = String(value || '').trim().toLowerCase();
    if (!email) return { ok: false, error: ERRORS.REQUIRED };
    if (!EMAIL_FORMAT.test(email)) return { ok: false, error: ERRORS.INVALID };
    if (isPersonalDomain(getDomain(email))) return { ok: false, error: ERRORS.PERSONAL };
    return { ok: true, email: email };
  }

  var api = {
    ERRORS: ERRORS,
    validateWorkEmail: validateWorkEmail,
    isPersonalDomain: isPersonalDomain,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqEmail = api;
})(typeof window !== 'undefined' ? window : this);

/* src/form-controller.js */
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
      if (config.onStep) config.onStep(step, getState());
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

    // Runs a submit function. A thrown error, a rejection or an HTTP status
    // outside successStatuses all end up as a rejected promise.
    function callSubmit(fn, payload) {
      return new Promise(function (resolve) {
        if (typeof fn !== 'function') throw new Error('Submit function is not configured');
        resolve(fn(payload));
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
