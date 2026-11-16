/*! Motorq Capability Check v1.2.0 | Brightscout */
/* src/vin-parser.js */
/**
 * Motorq Capability Check: VIN reading and processing in the browser.
 *
 * Pure logic, no DOM. Flow:
 *   file (.xlsx / .csv / .txt) or pasted text
 *     → clean up (Unicode look-alikes, invisible characters)
 *     → grid of rows and cells (CSV quotes respected; tabs or commas)
 *     → find the first real VIN by its pattern (the "anchor")
 *     → VINs listed across a row? read the grid sideways
 *     → keep the anchor's column, plus any other column that is mostly VINs
 *     → in those columns, keep VINs and skip titles, headers, footers and text
 *     → allowed-characters check on what will be sent   ("Invalid input")
 *     → any VINs?                                      ("No VINs detected")
 *     → remove duplicates and count
 *     → more than 1,000? → Talk to an Expert
 *
 * Invalid VINs in the VIN columns are still sent (Motorq requirement).
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
  var TOKEN_SEPARATORS = /[\s,]+/;
  // A modern VIN: 17 characters, no I, O or Q, at least one digit.
  var VIN_PATTERN = /^(?=[^0-9]*[0-9])[A-HJ-NPR-Z0-9]{17}$/i;
  // A mistyped or old VIN on its own: 5 to 20 letters and numbers, with at
  // least one letter and one digit.
  var VIN_LIKE = /^(?=[^0-9]*[0-9])(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9]{5,20}$/;
  // A mistyped VIN mixed with other words in the same cell: needs to be longer
  // so unit numbers, plates and model names ("12", "PL34", "F150") are skipped.
  var VIN_LIKE_LONG = /^(?=[^0-9]*[0-9])[A-Za-z0-9]{11,20}$/;
  // Header cells ("VIN", "VIN #", "Vehicle Identification Number"…).
  var HEADER_CELL = /(^|[^a-z])(vins?|vehicle|identification|chassis|serial)([^a-z]|$)/i;

  /* ---------- Text ---------- */

  // Letters that look identical to Latin ones (Cyrillic and Greek), which can
  // sneak in through other keyboards or copy-paste.
  var LOOK_ALIKES = {
    'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P',
    'С': 'C', 'Т': 'T', 'У': 'Y', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J',
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'ѕ': 's', 'і': 'i', 'ј': 'j',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M',
    'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
  };
  var LOOK_ALIKE_CHARS = new RegExp('[' + Object.keys(LOOK_ALIKES).join('') + ']', 'g');
  // Unicode line and paragraph separators (U+2028, U+2029).
  var LINE_SEPARATORS = new RegExp('[' + String.fromCharCode(0x2028, 0x2029) + ']', 'g');

  function normalizeText(text) {
    var s = String(text == null ? '' : text);
    if (/[^\x00-\x7F]/.test(s)) {
      s = s
        .normalize('NFKC')                    // full-width letters and digits → ASCII
        .replace(/\p{Cf}/gu, '')              // invisible: BOM, zero-width, soft hyphen, LRM/RLM
        .replace(/\p{Zs}/gu, ' ')             // non-breaking and other spaces
        .replace(LINE_SEPARATORS, '\n')
        .replace(LOOK_ALIKE_CHARS, function (ch) { return LOOK_ALIKES[ch]; });
    }
    return s.replace(/\r\n?/g, '\n');
  }

  /** Validates and processes pasted text or the contents of a CSV/TXT file. */
  function processText(text, options) {
    return extract(parseDelimited(normalizeText(text)), options);
  }

  /**
   * Splits text into rows and cells like a spreadsheet would. Tabs are the
   * column separator if there are any (copy from Excel), commas otherwise
   * (CSV). Quoted cells may contain separators, line breaks and "" quotes.
   */
  function parseDelimited(text) {
    var delimiter = text.indexOf('\t') !== -1 ? '\t' : ',';
    // No quotes (the usual case): a plain split is much faster on big files.
    if (text.indexOf('"') === -1) {
      return text.split('\n').map(function (line) {
        return line.split(delimiter).map(function (cell) { return cell.trim(); });
      });
    }
    var rows = parseWith(text, delimiter, true);
    // An unclosed quote: read the text again treating quotes as plain characters.
    return rows || parseWith(text, delimiter, false);
  }

  function parseWith(text, delimiter, useQuotes) {
    var rows = [];
    var row = [];
    var cell = '';
    var inQuotes = false;
    var atCellStart = true;

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQuotes) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else { inQuotes = false; }
        } else {
          cell += ch;
        }
      } else if (ch === '"' && useQuotes && atCellStart) {
        inQuotes = true;
        atCellStart = false;
      } else if (ch === delimiter) {
        row.push(cell.trim());
        cell = '';
        atCellStart = true;
      } else if (ch === '\n') {
        row.push(cell.trim());
        rows.push(row);
        row = [];
        cell = '';
        atCellStart = true;
      } else {
        cell += ch;
        if (ch !== ' ') atCellStart = false;
      }
    }
    if (inQuotes) return null;
    row.push(cell.trim());
    rows.push(row);
    return rows;
  }

  /* ---------- Rows (XLSX) ---------- */

  /** Processes rows already extracted from a spreadsheet (array of cell arrays). */
  function processRows(rawRows, options) {
    var rows = (rawRows || []).map(function (row) {
      return (row || []).map(function (cell) {
        return cell == null ? '' : normalizeText(cell).trim();
      });
    });
    return extract(rows, options);
  }

  /* ---------- Extraction ---------- */

  function extract(rows, options) {
    var opts = Object.assign({}, CONFIG, options || {});
    var anchor = findAnchor(rows);
    var tokens;

    if (anchor) {
      // VINs listed across a row: read the grid sideways.
      var right = countVinsRight(rows, anchor);
      if (right > 0 && right > countVinsDown(rows, anchor)) {
        rows = transpose(rows);
        anchor = findAnchor(rows);
      }
      tokens = tokensFromAnchor(rows, anchor);
    } else {
      tokens = tokensWithoutAnchor(rows);
    }

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

  function countVinsDown(rows, anchor) {
    var n = 0;
    for (var r = anchor.row + 1; r < rows.length; r++) if (isVinCell(rows[r][anchor.col])) n++;
    return n;
  }

  function countVinsRight(rows, anchor) {
    var n = 0;
    var row = rows[anchor.row];
    for (var c = anchor.col + 1; c < row.length; c++) if (isVinCell(row[c])) n++;
    return n;
  }

  function transpose(rows) {
    var width = 0;
    rows.forEach(function (row) { width = Math.max(width, row.length); });
    var out = [];
    for (var c = 0; c < width; c++) {
      out.push(rows.map(function (row) { return row[c] || ''; }));
    }
    return out;
  }

  /**
   * Keeps the anchor's column and any other column where most filled cells
   * (from the anchor row down) are VINs, then takes the VINs out of them.
   */
  function tokensFromAnchor(rows, anchor) {
    var cols = selectColumns(rows, anchor);
    var out = [];
    rows.forEach(function (row, r) {
      cols.forEach(function (c) {
        vinsInCell(row[c], r < anchor.row).forEach(function (t) { out.push(t); });
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
        if (isVinCell(cell)) vins++;
      }
      if (vins > 0 && vins * 2 >= filled) cols.push(c);
    }
    return cols;
  }

  /**
   * What to send from one cell of a VIN column:
   * - A cell with several words (a title, a footer, a row copied from a PDF):
   *   only its VINs, including mistyped ones that are long enough.
   * - A cell with one word: a header ("VIN") is skipped. Above the first real
   *   VIN, only something that looks like a VIN is kept (titles are skipped).
   *   Below it, anything else is sent: an invalid VIN is still a VIN.
   */
  function vinsInCell(cell, aboveAnchor) {
    var tokens = tokensOf(cell);
    if (!tokens.length) return [];

    if (tokens.length > 1) {
      return tokens.filter(function (t) { return isVin(t) || VIN_LIKE_LONG.test(t); });
    }

    var token = tokens[0];
    if (isVin(token)) return [token];
    if (isHeader(cell)) return [];
    if (aboveAnchor) return VIN_LIKE.test(token) ? [token] : [];
    return [token];
  }

  /**
   * No real VIN anywhere. Characters are still checked, but only values that
   * look like a VIN are sent, so a sheet with no VINs ("Make, Model, Year")
   * gives "No VINs detected" instead of sending its words.
   */
  function tokensWithoutAnchor(rows) {
    var out = [];
    rows.forEach(function (row) {
      row.forEach(function (cell) {
        if (!cell || isHeader(cell)) return;
        tokensOf(cell).forEach(function (t) {
          if (!TOKEN_ALLOWED.test(t) || VIN_LIKE.test(t)) out.push(t);
        });
      });
    });
    return out;
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

    var job = ext === 'xlsx'
      ? file.arrayBuffer().then(function (buffer) { return processRows(readWorkbookRows(buffer), options); })
      : file.text().then(function (text) { return processText(text, options); });

    return job.catch(function (err) {
      // Only our own codes are passed through; browser errors (a file that was
      // moved or deleted after being selected) are a file read error.
      var code = err && err.code === ERRORS.UNSUPPORTED_FILE ? ERRORS.UNSUPPORTED_FILE : ERRORS.FILE_READ;
      return fail(code, { cause: err && err.message });
    });
  }

  /**
   * First visible sheet of the .xlsx file as an array of rows.
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

    var sheet = workbook.Sheets[firstVisibleSheet(workbook)];
    // raw: keep numbers as numbers (no "1.23E+16" formatting).
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  }

  // Hidden sheets (lookups, templates) are skipped: the user sees the first visible one.
  function firstVisibleSheet(workbook) {
    var meta = (workbook.Workbook && workbook.Workbook.Sheets) || [];
    for (var i = 0; i < workbook.SheetNames.length; i++) {
      if (!(meta[i] && meta[i].Hidden)) return workbook.SheetNames[i];
    }
    return workbook.SheetNames[0];
  }

  /* ---------- Helpers ---------- */

  function tokensOf(cell) {
    return cell ? String(cell).split(TOKEN_SEPARATORS).filter(Boolean) : [];
  }

  function isVin(token) {
    return VIN_PATTERN.test(token);
  }

  /** A cell whose content is only real VINs. */
  function isVinCell(cell) {
    var tokens = tokensOf(cell);
    return tokens.length > 0 && tokens.every(isVin);
  }

  function isHeader(cell) {
    return HEADER_CELL.test(cell) && !tokensOf(cell).some(function (t) { return VIN_LIKE.test(t); });
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
    'ua', 'uk', 'us', 'uy', 've', 'vn', 'za',
  ].join('|');
  // Second-level forms (.com.co, .co.uk) are always country domains, so any
  // two letters are fine there.
  var ANY_TLD_PATTERN = new RegExp(
    '^(' + PROVIDERS_ANY_TLD.join('|') + ')\\.(com|net|org|' + COUNTRIES + '|com?\\.[a-z]{2})$'
  );

  // Specific domains. Their subdomains count too (nc.rr.com is rr.com).
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
    'zohomail.com', 'tutamail.com', 'lycos.com',
    // US ISPs (small fleet owners often use these)
    'rr.com', 'roadrunner.com', 'twc.com', 'centurylink.net', 'windstream.net',
    'frontiernet.net', 'embarqmail.com', 'netzero.net', 'netzero.com',
    'mindspring.com', 'cableone.net', 'suddenlink.net', 'mediacombb.net', 'wowway.com',
    // Europe
    'web.de', 'freenet.de', 't-online.de', 'orange.fr', 'wanadoo.fr',
    'free.fr', 'laposte.net', 'sfr.fr', 'libero.it', 'virgilio.it',
    'tiscali.it', 'btinternet.com', 'sky.com', 'virginmedia.com',
    'seznam.cz', 'wp.pl', 'o2.pl', 'interia.pl', 'onet.pl',
    'rambler.ru', 'list.ru', 'bk.ru', 'ukr.net',
    'abv.bg', 'email.cz', 'centrum.cz', 'gazeta.pl', 'alice.it', 'arcor.de',
    'bluewin.ch', 'ziggo.nl', 'telenet.be',
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
    domain = String(domain || '').normalize('NFKC').toLowerCase().trim();
    if (ANY_TLD_PATTERN.test(domain)) return true;
    // The domain itself or any parent domain (nc.rr.com → rr.com).
    var parts = domain.split('.');
    for (var i = 0; i < parts.length - 1; i++) {
      if (DOMAIN_SET[parts.slice(i).join('.')]) return true;
    }
    return false;
  }

  /** Returns { ok: true, email } or { ok: false, error }. */
  function validateWorkEmail(value) {
    // NFKC turns look-alike spellings into what mail servers actually use
    // ("ｇｍａｉｌ.com" or "gmaⅰl.com" → "gmail.com").
    var email = String(value || '').normalize('NFKC').trim().toLowerCase();
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
