import test from 'node:test';
import assert from 'node:assert/strict';
import { toHebrew, formatHebrew, nextOccurrence, upcoming, fromHebrew, addDays } from '../src/lib/hebrew.js';

test('converts civil dates to Hebrew dates', () => {
  const h = formatHebrew(toHebrew('2020-03-15'));
  assert.equal(h.en, '19 Adar, 5780');
  assert.equal(h.he, 'י״ט אדר תש״פ');
});

test('after sunset advances the Hebrew date', () => {
  assert.equal(formatHebrew(toHebrew('2020-03-15', true)).day, 20);
});

test('Hebrew to civil conversion round-trips', () => {
  assert.equal(fromHebrew(1, 'Tishrei', 5787), '2026-09-12');
  assert.equal(formatHebrew(toHebrew('2026-09-12')).en, '1 Tishrei, 5787');
});

test('next yahrzeit falls on the Hebrew anniversary', () => {
  const occ = { type: 'yahrzeit', gregorian_date: '2020-03-15', after_sunset: 0, observe: 'hebrew' };
  const next = nextOccurrence(occ, '2026-01-01');
  assert.equal(next.hebrew.day, 19);
  assert.match(next.hebrew.month, /^Adar/);
  assert.equal(next.count, 6);
  assert.equal(next.date, '2026-03-08');
});

test('a yahrzeit is not reported before the first anniversary year', () => {
  const occ = { type: 'yahrzeit', gregorian_date: '2026-05-01', after_sunset: 0, observe: 'hebrew' };
  const next = nextOccurrence(occ, '2026-05-02');
  assert.ok(next.date > '2027-01-01');
  assert.equal(next.count, 1);
});

test('gregorian observance keeps the civil date, Feb 29 falls back to Feb 28', () => {
  const occ = { type: 'birthday', gregorian_date: '2000-02-29', observe: 'gregorian' };
  assert.equal(nextOccurrence(occ, '2026-01-01').date, '2026-02-28');
  assert.equal(nextOccurrence(occ, '2028-01-01').date, '2028-02-29');
});

test('bar mitzvah is the 13th Hebrew birthday and only reported once', () => {
  const occ = { type: 'bar_mitzvah', gregorian_date: '2014-06-10', observe: 'hebrew' };
  const next = nextOccurrence(occ, '2026-01-01');
  assert.equal(next.count, 13);
  assert.equal(formatHebrew(toHebrew('2014-06-10')).day, next.hebrew.day);
  assert.equal(nextOccurrence(occ, addDays(next.date, 1)), null);
});

test('upcoming filters and sorts occasions within the window', () => {
  const list = upcoming([
    { id: 1, type: 'birthday', gregorian_date: '1990-01-20', observe: 'gregorian' },
    { id: 2, type: 'birthday', gregorian_date: '1990-01-10', observe: 'gregorian' },
    { id: 3, type: 'birthday', gregorian_date: '1990-06-10', observe: 'gregorian' },
  ], '2026-01-01', 30);
  assert.deepEqual(list.map((o) => o.id), [2, 1]);
  assert.equal(list[0].daysAway, 9);
});
