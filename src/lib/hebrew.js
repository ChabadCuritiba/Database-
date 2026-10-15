// Hebrew calendar engine built on @hebcal/core.
// All dates cross module boundaries as 'YYYY-MM-DD' strings to avoid
// timezone surprises; internally they are local-midnight Date objects.
import { HDate, HebrewCalendar } from '@hebcal/core';

export function parseISO(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  if (!m) throw new Error(`Invalid date: ${iso}`);
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (d.getMonth() !== Number(m[2]) - 1) throw new Error(`Invalid date: ${iso}`);
  return d;
}

export function toISO(date) {
  const d = date instanceof HDate ? date.greg() : date;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function todayISO() {
  return toISO(new Date());
}

export function addDays(iso, n) {
  const d = parseISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export function daysBetween(fromIso, toIso) {
  return Math.round((parseISO(toIso) - parseISO(fromIso)) / 86400000);
}

/** Hebrew date for a civil date. After sunset the Hebrew day has already advanced. */
export function toHebrew(iso, afterSunset = false) {
  const hd = new HDate(parseISO(iso));
  return afterSunset ? hd.next() : hd;
}

export function formatHebrew(hd) {
  return {
    en: hd.render('en', true).replace(/^(\d+)(st|nd|rd|th) of /, '$1 '),
    he: hd.renderGematriya(true),
    day: hd.getDate(),
    month: hd.getMonthName(),
    year: hd.getFullYear(),
  };
}

/** Convert a Hebrew date (day, month name, year) to a civil ISO date. */
export function fromHebrew(day, month, year) {
  return toISO(new HDate(Number(day), month, Number(year)));
}

export const HEBREW_MONTHS = [
  'Nisan', 'Iyyar', 'Sivan', 'Tamuz', 'Av', 'Elul', 'Tishrei',
  'Cheshvan', 'Kislev', 'Tevet', "Sh'vat", 'Adar', 'Adar I', 'Adar II',
];

function gregorianAnniversary(origIso, year) {
  const o = parseISO(origIso);
  let d = new Date(year, o.getMonth(), o.getDate());
  if (d.getMonth() !== o.getMonth()) d = new Date(year, o.getMonth() + 1, 0); // Feb 29 -> Feb 28
  return toISO(d);
}

/**
 * Next observance on or after `fromIso` for an occasion row
 * ({type, gregorian_date, after_sunset, observe}).
 * Returns { date, hdate, hebrew, count } or null if none (e.g. a past bar mitzvah).
 * `count` is the number of years since the original event.
 */
export function nextOccurrence(occ, fromIso = todayISO()) {
  const orig = toHebrew(occ.gregorian_date, !!occ.after_sunset);
  const from = parseISO(fromIso);

  if (occ.type === 'bar_mitzvah' || occ.type === 'bat_mitzvah') {
    const age = occ.type === 'bar_mitzvah' ? 13 : 12;
    const hd = HebrewCalendar.getBirthdayOrAnniversary(orig.getFullYear() + age, orig);
    if (!hd || hd.greg() < from) return null;
    return result(hd, age);
  }

  if (occ.observe === 'gregorian') {
    const origYear = parseISO(occ.gregorian_date).getFullYear();
    for (let y = from.getFullYear(); y <= from.getFullYear() + 1; y++) {
      if (y <= origYear) continue;
      const iso = gregorianAnniversary(occ.gregorian_date, y);
      if (parseISO(iso) >= from) return result(toHebrew(iso), y - origYear, iso);
    }
    return null;
  }

  const startHy = new HDate(from).getFullYear();
  for (let hy = startHy; hy <= startHy + 1; hy++) {
    if (hy <= orig.getFullYear()) continue;
    const hd =
      occ.type === 'yahrzeit'
        ? HebrewCalendar.getYahrzeit(hy, orig)
        : HebrewCalendar.getBirthdayOrAnniversary(hy, orig);
    if (hd && hd.greg() >= from) return result(hd, hy - orig.getFullYear());
  }
  return null;
}

function result(hd, count, iso = toISO(hd)) {
  return { date: iso, hdate: hd, hebrew: formatHebrew(hd), count };
}

/** Occasions observed within [fromIso, fromIso + days], sorted by date. */
export function upcoming(occasions, fromIso = todayISO(), days = 30) {
  const until = addDays(fromIso, days);
  const out = [];
  for (const occ of occasions) {
    const next = nextOccurrence(occ, fromIso);
    if (next && next.date <= until) out.push({ ...occ, next, daysAway: daysBetween(fromIso, next.date) });
  }
  return out.sort((a, b) => a.next.date.localeCompare(b.next.date));
}

export function formatGregorian(iso, locale = 'en-US') {
  return parseISO(iso).toLocaleDateString(locale, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

export const OCCASION_LABELS = {
  yahrzeit: 'Yahrzeit',
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  bar_mitzvah: 'Bar Mitzvah',
  bat_mitzvah: 'Bat Mitzvah',
  other: 'Occasion',
};
