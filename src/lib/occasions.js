// Lifecycle occasion helpers: upcoming lists, Yahrzeit letters and automated reminders.
import { getSettings } from '../db/index.js';
import { addDays, formatGregorian, nextOccurrence, OCCASION_LABELS, todayISO, upcoming } from './hebrew.js';
import { merge, salutationOf, textToHtml } from './format.js';
import { deliver } from './messaging.js';
import { config } from '../config.js';

export function allOccasions(db, where = '', params = []) {
  return db
    .prepare(`SELECT o.*, f.family_name, f.salutation, f.email family_email, f.mobile family_mobile,
                     f.no_email, f.no_sms
              FROM occasions o JOIN families f ON f.id = o.family_id ${where}`)
    .all(...params);
}

export function upcomingOccasions(db, { from = todayISO(), days = 30, type } = {}) {
  const rows = type ? allOccasions(db, 'WHERE o.type = ?', [type]) : allOccasions(db);
  return upcoming(rows, from, days);
}

export function occasionMergeData(occ, next, settings) {
  return {
    salutation: salutationOf(occ),
    family_name: occ.family_name,
    name: occ.name,
    hebrew_name: occ.hebrew_name || '',
    relationship: occ.relationship || '',
    type: OCCASION_LABELS[occ.type] || occ.type,
    hebrew_date: next.hebrew.en,
    hebrew_date_he: next.hebrew.he,
    gregorian_date: formatGregorian(next.date, config.locale),
    eve_date: formatGregorian(addDays(next.date, -1), config.locale),
    years: next.count,
    org_name: settings.org_name,
  };
}

/** Yahrzeit letters for occasions observed within a window. */
export function yahrzeitLetters(db, { from = todayISO(), days = 30, ids } = {}) {
  const settings = getSettings(db);
  let list = upcomingOccasions(db, { from, days, type: 'yahrzeit' });
  if (ids?.length) list = list.filter((o) => ids.includes(o.id));
  return list.map((o) => {
    const family = db.prepare('SELECT * FROM families WHERE id = ?').get(o.family_id);
    const data = occasionMergeData(o, o.next, settings);
    return {
      family,
      occasion: o,
      hebrewLine: `${o.next.hebrew.he}  ·  ${o.next.hebrew.en}`,
      body: merge(settings.yahrzeit_body, data),
    };
  });
}

/**
 * Sends due reminders. An occasion is due when its next observance is within
 * remind_days_before days. Each (occasion, observance, channel) is sent once.
 */
export async function sendDueReminders(db, today = todayISO()) {
  const settings = getSettings(db);
  const rows = allOccasions(db, 'WHERE o.remind = 1');
  const already = db.prepare('SELECT 1 FROM reminder_log WHERE occasion_id = ? AND occurrence = ? AND channel = ?');
  const log = db.prepare('INSERT OR IGNORE INTO reminder_log (occasion_id, occurrence, channel) VALUES (?, ?, ?)');
  const stats = { checked: rows.length, sent: 0, failed: 0 };

  for (const occ of rows) {
    const next = nextOccurrence(occ, today);
    if (!next || next.date > addDays(today, occ.remind_days_before)) continue;
    const data = occasionMergeData(occ, next, settings);
    const body = merge(settings.reminder_body, data);
    const jobs = [];
    if (occ.remind_email && occ.family_email && !occ.no_email) {
      jobs.push(['email', () => deliver(db, {
        channel: 'email', to: occ.family_email, familyId: occ.family_id,
        subject: merge(settings.reminder_email_subject, data), text: body, html: textToHtml(body),
      })]);
    }
    if (occ.remind_sms && occ.family_mobile && !occ.no_sms) {
      jobs.push(['sms', () => deliver(db, { channel: 'sms', to: occ.family_mobile, familyId: occ.family_id, body: body.slice(0, 600) })]);
    }
    for (const [channel, send] of jobs) {
      if (already.get(occ.id, next.date, channel)) continue;
      const r = await send();
      if (r.status === 'failed') stats.failed++;
      else { stats.sent++; log.run(occ.id, next.date, channel); }
    }
  }
  return stats;
}
