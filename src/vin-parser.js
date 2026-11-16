/**
 * Motorq Capability Check: VIN reading and processing in the browser.
 *
 * Pure logic, no DOM. Flow:
 *   file (.xlsx / .csv / .txt) or pasted text
 *     → plain text
 *     → allowed-characters check          ("Invalid input")
 *     → VIN extraction (no header, no empty rows, no whitespace)
 *     → any VINs?                         ("No VINs detected")
 *     → remove duplicates and count
 *     → more than 1,000? → Talk to an Expert
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

  // Letters, numbers, spaces, commas and line breaks (Motorq requirement).
  // Tabs are also allowed because copying several cells from Excel adds them.
  var ALLOWED_CHARS = /^[A-Za-z0-9 ,\t\r\n]*$/;
  var SEPARATORS = /[\s,]+/;
  // A real VIN is 17 alphanumeric characters.
  var VIN_LIKE = /^[A-Za-z0-9]{17}$/;
  var HEADER_LIKE = /vin/i;

  /* ---------- Text ---------- */

  function normalizeText(text) {
    return String(text || '')
      .replace(/^﻿/, '')       // BOM added by Excel exports
      .replace(/\r\n?/g, '\n');
  }

  /** Validates and processes pasted text or the contents of a CSV/TXT file. */
  function processText(text, options) {
    var opts = Object.assign({}, CONFIG, options || {});
    var clean = normalizeText(text);

    if (!ALLOWED_CHARS.test(clean)) {
      return fail(ERRORS.INVALID_INPUT, { invalidChars: findInvalidChars(clean) });
    }

    var rows = clean.split('\n').map(function (line) {
      return line.split(SEPARATORS).filter(Boolean);
    }).filter(function (cells) { return cells.length > 0; });

    return finish(dropHeaderRow(rows), opts);
  }

  /* ---------- Rows (XLSX) ---------- */

  /**
   * Processes rows already extracted from a spreadsheet (array of cell arrays).
   * If there is a header row with a "VIN" column, only that column is used.
   */
  function processRows(rawRows, options) {
    var opts = Object.assign({}, CONFIG, options || {});

    var rows = rawRows.map(function (row) {
      return (row || []).map(function (cell) {
        return cell == null ? '' : String(cell).trim();
      });
    }).filter(function (row) {
      return row.some(Boolean);
    });

    var vinCol = findVinColumn(rows[0]);
    if (vinCol !== -1) {
      rows = rows.slice(1).map(function (row) { return [row[vinCol] || '']; });
    }

    var text = rows.map(function (row) { return row.filter(Boolean).join(','); }).join('\n');
    return processText(text, opts);
  }

  function findVinColumn(firstRow) {
    if (!firstRow) return -1;
    for (var i = 0; i < firstRow.length; i++) {
      var cell = firstRow[i];
      if (cell && HEADER_LIKE.test(cell) && !VIN_LIKE.test(cell)) return i;
    }
    return -1;
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
        return fail(ERRORS.FILE_READ, { cause: err && err.message });
      });
    }

    return file.text().then(function (text) {
      return processText(text, options);
    }).catch(function (err) {
      return fail(ERRORS.FILE_READ, { cause: err && err.message });
    });
  }

  /** First sheet of the .xlsx file as an array of rows. */
  function readWorkbookRows(buffer, xlsxLib) {
    var XLSX = xlsxLib || root.XLSX;
    if (!XLSX) throw new Error('SheetJS (XLSX) is not loaded');
    var workbook = XLSX.read(buffer, { type: 'array' });
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  }

  /* ---------- Helpers ---------- */

  // The first row is a header if it mentions "VIN" and doesn't look like a real VIN.
  function dropHeaderRow(rows) {
    if (!rows.length) return rows;
    var first = rows[0];
    var looksLikeHeader = first.some(function (cell) {
      return HEADER_LIKE.test(cell) && !VIN_LIKE.test(cell);
    });
    return looksLikeHeader ? rows.slice(1) : rows;
  }

  function finish(rows, opts) {
    var all = [];
    rows.forEach(function (cells) {
      cells.forEach(function (cell) { all.push(cell.toUpperCase()); });
    });

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
    var found = text.replace(/[A-Za-z0-9 ,\t\n]/g, '');
    return unique(found.split('')).slice(0, 10);
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
