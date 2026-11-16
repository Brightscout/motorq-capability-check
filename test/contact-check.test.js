const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/contact-check.js');

test('joinName: first + last, trimmed and with single spaces', () => {
  assert.strictEqual(C.joinName('Jane', 'Doe'), 'Jane Doe');
  assert.strictEqual(C.joinName('  Jane ', ' Doe  '), 'Jane Doe');
  assert.strictEqual(C.joinName('Mary  Ann', 'van  der Berg'), 'Mary Ann van der Berg');
});

test('joinName: a missing part does not leave extra spaces', () => {
  assert.strictEqual(C.joinName('Jane', ''), 'Jane');
  assert.strictEqual(C.joinName('', 'Doe'), 'Doe');
  assert.strictEqual(C.joinName(null, undefined), '');
});

test('validatePhone: accepts digits, spaces, dashes and parentheses', () => {
  for (const p of ['5551234567', '(555) 123-4567', '11 4567-8901', '123456', '123456789012345']) {
    assert.deepStrictEqual(C.validatePhone(p), { ok: true, phone: p }, p);
  }
  assert.deepStrictEqual(C.validatePhone('  555 1234  '), { ok: true, phone: '555 1234' });
});

test('validatePhone: empty is required', () => {
  assert.strictEqual(C.validatePhone('').error, C.ERRORS.PHONE_REQUIRED);
  assert.strictEqual(C.validatePhone('   ').error, C.ERRORS.PHONE_REQUIRED);
});

test('validatePhone: other characters are invalid', () => {
  for (const p of ['+1 555 1234567', '555.123.4567', '555-CALL-NOW', '555 1234 ext 2']) {
    assert.strictEqual(C.validatePhone(p).error, C.ERRORS.PHONE_INVALID, p);
  }
});

test('validatePhone: fewer than 6 or more than 15 digits is invalid', () => {
  assert.strictEqual(C.validatePhone('12345').error, C.ERRORS.PHONE_INVALID);
  assert.strictEqual(C.validatePhone('1234567890123456').error, C.ERRORS.PHONE_INVALID);
  assert.strictEqual(C.validatePhone('(--) 12').error, C.ERRORS.PHONE_INVALID);
});

test('fleet sizes and phone countries have defaults', () => {
  assert.ok(C.FLEET_SIZES.length > 0);
  assert.ok(C.PHONE_COUNTRIES.every((c) => /^\+\d+$/.test(c.value) && c.label));
});
