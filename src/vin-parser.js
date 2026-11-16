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
