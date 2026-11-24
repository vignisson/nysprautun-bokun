import { test } from 'node:test';
import assert from 'node:assert';
import { asciiIs, normPhone, normPlate, fill, isDate, isTime } from '../src/util.js';

test('SMS án íslenskra stafa', () => {
  assert.equal(asciiIs('Bíllinn þinn er tilbúinn – Æsufell ðö'), 'Billinn thinn er tilbuinn - Aesufell do');
});
test('símanúmer', () => {
  assert.equal(normPhone('699 1234'), '+3546991234');
  assert.equal(normPhone('00354 6991234'), '+3546991234');
  assert.equal(normPhone('+45 12345678'), '+4512345678');
});
test('bílnúmer', () => assert.equal(normPlate(' ab-123 '), 'AB123'));
test('sniðmát', () => assert.equal(fill('{a} og {b}{c}', { a: 1, b: 'x' }), '1 og x'));
test('íslensk dagsetning', () => {
  assert.equal(isDate('2026-11-25T09:30:00Z'), 'miðvikudaginn 25. nóvember');
  assert.equal(isTime('2026-11-25T09:30:00Z'), '09:30');
});
