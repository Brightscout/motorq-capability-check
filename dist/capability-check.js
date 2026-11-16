/*! Motorq Capability Check v1.3.0 | Brightscout */
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
   * column separator when most lines have them (copy from Excel), commas
   * otherwise (CSV, even with a stray tab). Quoted cells may contain
   * separators, line breaks and "" quotes.
   */
  function parseDelimited(text) {
    var delimiter = chooseDelimiter(text);
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

  function chooseDelimiter(text) {
    if (text.indexOf('\t') === -1) return ',';
    if (text.indexOf(',') === -1) return '\t';
    var tabs = 0;
    var commas = 0;
    text.split('\n').forEach(function (line) {
      if (line.indexOf('\t') !== -1) tabs++;
      if (line.indexOf(',') !== -1) commas++;
    });
    return tabs >= commas ? '\t' : ',';
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
      var sideways = right > 0 && right > countVinsDown(rows, anchor);
      if (sideways) {
        rows = transpose(rows);
        anchor = findAnchor(rows);
      }
      tokens = tokensFromAnchor(rows, anchor, sideways);
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
  function tokensFromAnchor(rows, anchor, sideways) {
    var cols = selectColumns(rows, anchor);
    var out = [];
    rows.forEach(function (row, r) {
      cols.forEach(function (c) {
        vinsInCell(row[c], r < anchor.row, sideways).forEach(function (t) { out.push(t); });
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
   * - Read sideways, "above" is what was left of the first VIN in the row
   *   (unit numbers, plates), so only long values (11+) are kept there.
   */
  function vinsInCell(cell, aboveAnchor, sideways) {
    var tokens = tokensOf(cell);
    if (!tokens.length) return [];

    if (tokens.length > 1) {
      return tokens.filter(function (t) { return isVin(t) || VIN_LIKE_LONG.test(t); });
    }

    var token = tokens[0];
    if (isVin(token)) return [token];
    if (isHeader(cell)) return [];
    if (aboveAnchor) return (sideways ? VIN_LIKE_LONG : VIN_LIKE).test(token) ? [token] : [];
    return [token];
  }

  /**
   * No real VIN anywhere (all of them short or mistyped).
   * - With a VIN header ("VIN", "Vehicle Identification Number"…): only the
   *   values in those columns, below the header.
   * - Without one: only values that look like a VIN are sent, so a sheet with
   *   no VINs ("Make, Model, Year") gives "No VINs detected".
   * Characters only count in what would be sent, or in values that look like
   * a VIN with stray characters ("1HGCM82633A00435;2"). Dates, models
   * ("F-150") and notes in other columns don't make the file invalid.
   */
  function tokensWithoutAnchor(rows) {
    var out = [];
    var header = findHeader(rows);
    if (header) {
      for (var r = header.row + 1; r < rows.length; r++) {
        header.cols.forEach(function (c) {
          vinsInCell(rows[r][c], false).forEach(function (t) { out.push(t); });
        });
      }
      return out;
    }
    rows.forEach(function (row) {
      row.forEach(function (cell) {
        if (!cell) return;
        tokensOf(cell).forEach(function (t) {
          if (VIN_LIKE.test(t) || (!TOKEN_ALLOWED.test(t) && looksLikeBrokenVin(t))) out.push(t);
        });
      });
    });
    return out;
  }

  /** First row with a VIN header cell, and the columns of those cells. */
  function findHeader(rows) {
    for (var r = 0; r < rows.length; r++) {
      var cols = [];
      rows[r].forEach(function (cell, c) { if (cell && isHeader(cell)) cols.push(c); });
      if (cols.length) return { row: r, cols: cols };
    }
    return null;
  }

  function looksLikeBrokenVin(token) {
    return token.split(/[^A-Za-z0-9]+/).some(function (part) { return VIN_LIKE.test(part); });
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

/* src/contact-check.js */
/**
 * Motorq Capability Check: contact field helpers (step 2 and Talk to an Expert).
 *
 * Pure logic, no DOM. Exposes window.MotorqContact in the browser and
 * module.exports in Node (tests).
 */
(function (root) {
  'use strict';

  var ERRORS = {
    PHONE_REQUIRED: 'phone_required',
    PHONE_INVALID: 'phone_invalid',
  };

  // Placeholder options until the client sends the final ones. Replace them
  // through the `fleetSizes` option of MotorqCapCheck.init.
  var FLEET_SIZES = ['1-25', '26-100', '101-500', '501-1,000', '1,000+'];

  // Country codes for the phone select. Replace through the `phoneCountries` option.
  var PHONE_COUNTRIES = [
    { value: '+1', label: 'US/CA +1' },
    { value: '+52', label: 'MX +52' },
    { value: '+44', label: 'UK +44' },
    { value: '+49', label: 'DE +49' },
    { value: '+33', label: 'FR +33' },
    { value: '+34', label: 'ES +34' },
    { value: '+39', label: 'IT +39' },
    { value: '+31', label: 'NL +31' },
    { value: '+55', label: 'BR +55' },
    { value: '+54', label: 'AR +54' },
    { value: '+57', label: 'CO +57' },
    { value: '+56', label: 'CL +56' },
    { value: '+91', label: 'IN +91' },
    { value: '+61', label: 'AU +61' },
    { value: '+81', label: 'JP +81' },
  ];

  /** "Jane" + "Doe" → "Jane Doe". Extra spaces are collapsed and trimmed. */
  function joinName(first, last) {
    return [first, last]
      .map(function (part) { return String(part == null ? '' : part).replace(/\s+/g, ' ').trim(); })
      .filter(Boolean)
      .join(' ');
  }

  /**
   * Basic phone check: digits, spaces, dashes and parentheses only, with
   * 6 to 15 digits. Returns { ok: true, phone } (trimmed) or { ok: false, error }.
   */
  function validatePhone(value) {
    var phone = String(value == null ? '' : value).trim();
    if (!phone) return { ok: false, error: ERRORS.PHONE_REQUIRED };
    if (!/^[0-9\s()-]+$/.test(phone)) return { ok: false, error: ERRORS.PHONE_INVALID };
    var digits = phone.replace(/\D/g, '').length;
    if (digits < 6 || digits > 15) return { ok: false, error: ERRORS.PHONE_INVALID };
    return { ok: true, phone: phone };
  }

  var api = {
    ERRORS: ERRORS,
    FLEET_SIZES: FLEET_SIZES,
    PHONE_COUNTRIES: PHONE_COUNTRIES,
    joinName: joinName,
    validatePhone: validatePhone,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MotorqContact = api;
})(typeof window !== 'undefined' ? window : this);

/* src/form-controller.js */
/**
 * Motorq Capability Check: form controller (steps, tabs, live VIN count, Back,
 * VINs kept in memory, submits).
 *
 * Markup-agnostic: every element is found through configurable selectors, so it
 * can be wired to the Webflow markup by changing only the `selectors` object.
 *
 * Requires MotorqVins (vin-parser.js), MotorqEmail (email-check.js) and
 * MotorqContact (contact-check.js).
 *
 * Usage:
 *   MotorqCapCheck.init({
 *     root: '#cap-check',
 *     submitCheck:  function (payload, opts) { return fetch(..., { signal: opts.signal }) },
 *     submitExpert: function (payload) { return fetch(...) },  // HubSpot Forms API
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
    var useHistory = config.history !== false && !!root.history &&
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
      goTo('expert');
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

      var payload = {
        fleetSize: fleetSize,
        companyName: companyName,
        email: emailCheck.email,
        phone: country + ' ' + phoneCheck.phone,
        source: state.expertSource || 'link',
      };
      var vinCount = currentVinCount();
      if (vinCount) payload.vinCount = vinCount;

      // Optional: HubSpot can't verify it, so it never blocks the submit.
      var token = '';
      try {
        token = config.getExpertTurnstileToken ? config.getExpertTurnstileToken() : '';
      } catch (e) { /* not loaded */ }
      if (token) payload.turnstileToken = token;

      setBusy(true);
      return callSubmit(config.submitExpert, payload).then(function () {
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

    goTo('vins', { isBack: true, initial: true });
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
