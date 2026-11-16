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
