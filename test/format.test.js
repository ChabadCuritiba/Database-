import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, merge, formatAddress } from '../src/lib/format.js';
import { toE164 } from '../src/lib/messaging.js';

test('parseMoney understands Brazilian and US formats', () => {
  assert.equal(parseMoney('1.234,56'), 123456);
  assert.equal(parseMoney('1,234.56'), 123456);
  assert.equal(parseMoney('R$ 50'), 5000);
  assert.equal(parseMoney('12,5'), 1250);
  assert.equal(parseMoney('1.000'), 100000);
  assert.equal(parseMoney('1.000.000'), 100000000);
  assert.equal(parseMoney(''), 0);
  assert.equal(parseMoney('abc'), 0);
});

test('merge replaces placeholders and blanks unknown ones', () => {
  assert.equal(merge('Dear {{ salutation }}, {{x}}!', { salutation: 'Cohen Family' }), 'Dear Cohen Family, !');
});

test('formatAddress builds Brazilian address lines', () => {
  assert.deepEqual(formatAddress({ street: 'Rua XV', number: '10', complement: 'ap 3', neighborhood: 'Centro', city: 'Curitiba', state: 'PR', cep: '80020000' }), [
    'Rua XV, 10 - ap 3', 'Centro - Curitiba/PR', 'CEP 80020-000',
  ]);
});

test('toE164 normalises Brazilian phone numbers', () => {
  assert.equal(toE164('(41) 99999-0000'), '+5541999990000');
  assert.equal(toE164('+1 (212) 555-1234'), '+12125551234');
  assert.equal(toE164(''), '');
});
