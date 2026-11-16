const test = require('node:test');
const assert = require('node:assert');
const XLSX = require('xlsx');
const V = require('../src/vin-parser.js');

const A = '1HGCM82633A004352';
const B = '5YJSA1E26HF000337';
const C = 'WVWZZZ1JZXW000001';

function makeVins(n) {
  return Array.from({ length: n }, (_, i) => 'TEST' + String(i).padStart(13, '0'));
}

test('pasted text: comma, space or line break separated', () => {
  const r = V.processText(`${A}, ${B}\n${C}`);
  assert.deepStrictEqual(r.vins, [A, B, C]);
  assert.strictEqual(V.toApiString(r.vins), `${A},${B},${C}`);
});

test('cleans empty rows, whitespace, CRLF and BOM', () => {
  const r = V.processText(`﻿\r\n  ${A}  \r\n\r\n${B}\r\n`);
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('drops the header row', () => {
  assert.deepStrictEqual(V.processText(`VIN\n${A}\n${B}`).vins, [A, B]);
  assert.deepStrictEqual(V.processText(`VIN Number\n${A}`).vins, [A]);
});

test('does not mistake a VIN containing "VIN" for a header', () => {
  const vinLike = 'VIN12345678901234';
  assert.deepStrictEqual(V.processText(`${vinLike}\n${A}`).vins, [vinLike, A]);
});

test('Invalid input on disallowed characters', () => {
  const r = V.processText(`${A};${B}`);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, V.ERRORS.INVALID_INPUT);
  assert.deepStrictEqual(r.invalidChars, [';']);
});

test('No VINs detected on empty text or header only', () => {
  assert.strictEqual(V.processText('').error, V.ERRORS.NO_VINS);
  assert.strictEqual(V.processText(' \n , \n').error, V.ERRORS.NO_VINS);
  assert.strictEqual(V.processText('VIN\n').error, V.ERRORS.NO_VINS);
});

test('invalid VINs are still sent', () => {
  assert.deepStrictEqual(V.processText(`${A}\nabc`).vins, [A, 'ABC']);
});

test('removes duplicates (case-insensitive) and counts them', () => {
  const r = V.processText(`${A}\n${A.toLowerCase()}\n${B}`);
  assert.deepStrictEqual(r.vins, [A, B]);
  assert.strictEqual(r.totalFound, 3);
  assert.strictEqual(r.duplicatesRemoved, 1);
});

test('with DEDUPE false, sends everything', () => {
  const r = V.processText(`${A}\n${A}`, { DEDUPE: false });
  assert.strictEqual(r.count, 2);
});

test('exactly 1,000 does not go to Talk to an Expert, 1,001 does', () => {
  assert.strictEqual(V.processText(makeVins(1000).join('\n')).needsExpert, false);
  assert.strictEqual(V.processText(makeVins(1001).join('\n')).needsExpert, true);
});

test('1,001 with one duplicate becomes 1,000 and does not go to Expert', () => {
  const list = makeVins(1000);
  list.push(list[0]);
  const r = V.processText(list.join('\n'));
  assert.strictEqual(r.count, 1000);
  assert.strictEqual(r.needsExpert, false);
});

test('xlsx: uses only the VIN column when there is a header', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['Make', 'VIN', 'Model'],
    ['Honda', A, 'Accord-EX'],
    ['', '', ''],
    ['Tesla', B, 'Model S'],
  ]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Fleet');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  const rows = V.readWorkbookRows(buf, XLSX);
  const r = V.processRows(rows);
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('xlsx: without a header, uses every cell', () => {
  const r = V.processRows([[A, B], [C], [null, '']]);
  assert.deepStrictEqual(r.vins, [A, B, C]);
});

test('processFile: rejects .xls and other formats', async () => {
  const r = await V.processFile({ name: 'fleet.xls' });
  assert.strictEqual(r.error, V.ERRORS.UNSUPPORTED_FILE);
});

test('processFile: reads CSV and TXT', async () => {
  const file = { name: 'fleet.CSV', text: async () => `VIN\n${A}\n${B}\n` };
  const r = await V.processFile(file);
  assert.deepStrictEqual(r.vins, [A, B]);
});

/* Regressions found in the v1.2.0 review */

test('no real VIN: dates, models and notes in other columns do not make the input invalid', () => {
  assert.deepStrictEqual(V.processText('Unit,VIN,Purchased\n1,JH4DA935XMS00001,01/02/2020').vins, ['JH4DA935XMS00001']);
  assert.deepStrictEqual(V.processText('VIN,Notes\nJH4DA935XMS00001,Bumper damaged.').vins, ['JH4DA935XMS00001']);
  assert.strictEqual(V.processText('Make,Model,Year\nFord,F-150,2019').error, V.ERRORS.NO_VINS);
});

test('no real VIN: a VIN-like value with a stray character is still invalid', () => {
  const r = V.processText('JH4DA935XMS0000;1');
  assert.strictEqual(r.error, V.ERRORS.INVALID_INPUT);
  assert.deepStrictEqual(r.invalidChars, [';']);
});

test('VINs across one row: the unit number or plate on the left is not sent', () => {
  assert.deepStrictEqual(V.processText(`Unit,VIN,Trailer VIN\nTRK1001,${A},${B}`).vins, [A, B]);
  assert.deepStrictEqual(V.processText(`TRK1001\t${A}\t${B}`).vins, [A, B]);
  assert.deepStrictEqual(V.processText(`Plate,VIN,Old VIN\nABC1234,${A},${B}`).vins, [A, B]);
  // A mistyped VIN on the left is still kept.
  assert.deepStrictEqual(V.processText(`1G1AZ37DXXX00001,${A},${B}`).vins, ['1G1AZ37DXXX00001', A, B]);
});

test('a stray tab in a CSV does not switch it to tab-separated', () => {
  const r = V.processText(`Unit,VIN,Phone\n1,${A},18005551234\n2,${B},18005551235\t`);
  assert.deepStrictEqual(r.vins, [A, B]);
});

test('copy from Excel with commas inside cells is still tab-separated', () => {
  assert.deepStrictEqual(V.processText(`Name\tVIN\nSmith, John\t${A}\nDoe, Jane\t${B}`).vins, [A, B]);
});
