const test = require('node:test');
const assert = require('node:assert');
const E = require('../src/email-check.js');

test('accepts work emails', () => {
  for (const email of ['jane@motorq.com', 'ops@fleet.co.uk', 'a.b+c@acme-corp.com.ar']) {
    assert.strictEqual(E.validateWorkEmail(email).ok, true, email);
  }
});

test('normalizes whitespace and case', () => {
  assert.deepStrictEqual(E.validateWorkEmail('  Jane@Motorq.COM '), { ok: true, email: 'jane@motorq.com' });
});

test('blocks major free providers', () => {
  for (const email of ['x@gmail.com', 'x@yahoo.com', 'x@outlook.com', 'x@hotmail.com',
    'x@icloud.com', 'x@proton.me', 'x@aol.com', 'x@qq.com']) {
    assert.strictEqual(E.validateWorkEmail(email).error, E.ERRORS.PERSONAL, email);
  }
});

test('blocks country-specific variants', () => {
  for (const email of ['x@yahoo.co.uk', 'x@hotmail.com.ar', 'x@gmx.de', 'x@yandex.ru',
    'x@live.fr', 'x@outlook.es', 'x@yahoo.com.br']) {
    assert.strictEqual(E.validateWorkEmail(email).error, E.ERRORS.PERSONAL, email);
  }
});

test('does not block company domains that start with a provider name', () => {
  for (const email of ['x@live.acme.com', 'x@mail.motorq.com', 'x@outlook.company.io', 'x@gmailer.com']) {
    assert.strictEqual(E.validateWorkEmail(email).ok, true, email);
  }
});

test('required and invalid format', () => {
  assert.strictEqual(E.validateWorkEmail('').error, E.ERRORS.REQUIRED);
  assert.strictEqual(E.validateWorkEmail('   ').error, E.ERRORS.REQUIRED);
  for (const email of ['jane', 'jane@', '@motorq.com', 'jane@motorq', 'ja ne@motorq.com']) {
    assert.strictEqual(E.validateWorkEmail(email).error, E.ERRORS.INVALID, email);
  }
});
