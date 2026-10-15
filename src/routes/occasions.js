import express from 'express';
import { requirePermission } from '../lib/permissions.js';
import { upcomingOccasions, yahrzeitLetters, sendDueReminders } from '../lib/occasions.js';
import { toHebrew, formatHebrew, fromHebrew, todayISO, HEBREW_MONTHS, OCCASION_LABELS } from '../lib/hebrew.js';
import { lettersPdf } from '../lib/pdf.js';
import { lettersDocx } from '../lib/word.js';
import { getSettings } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { str, bool, int, date, ids, oneOf, mustGet, httpError } from '../lib/forms.js';

const router = express.Router();
const TYPES = Object.keys(OCCASION_LABELS);

router.get('/', requirePermission('occasions.read'), (req, res) => {
  const db = req.app.get('db');
  const days = Math.min(400, Math.max(1, int(req.query.days, 30)));
  const from = date(req.query.from) || todayISO();
  const type = TYPES.includes(req.query.type) ? req.query.type : undefined;
  res.render('occasions/index', { title: 'Upcoming occasions', list: upcomingOccasions(db, { from, days, type }), days, from, type, types: TYPES });
});

// Hebrew <-> Gregorian converter.
router.get('/convert', requirePermission('occasions.read'), (req, res) => {
  let result = null;
  let error = null;
  try {
    if (date(req.query.gdate)) {
      const hd = toHebrew(req.query.gdate, bool(req.query.after_sunset));
      result = { gregorian: req.query.gdate, hebrew: formatHebrew(hd) };
    } else if (req.query.hday && req.query.hmonth && req.query.hyear) {
      const g = fromHebrew(req.query.hday, req.query.hmonth, req.query.hyear);
      result = { gregorian: g, hebrew: formatHebrew(toHebrew(g)) };
    }
  } catch (e) { error = e.message; }
  res.render('occasions/convert', { title: 'Hebrew date converter', result, error, q: req.query, months: HEBREW_MONTHS });
});

router.get('/yahrzeit-letters', requirePermission('occasions.read'), (req, res) => {
  const db = req.app.get('db');
  const from = date(req.query.from) || todayISO();
  const days = Math.min(400, Math.max(1, int(req.query.days, 30)));
  res.render('occasions/letters', { title: 'Yahrzeit letters', letters: yahrzeitLetters(db, { from, days }), from, days });
});

router.post('/yahrzeit-letters', requirePermission('occasions.read'), async (req, res) => {
  const db = req.app.get('db');
  const from = date(req.body.from) || todayISO();
  const days = Math.min(400, Math.max(1, int(req.body.days, 30)));
  const letters = yahrzeitLetters(db, { from, days, ids: ids(req.body.ids) });
  if (!letters.length) throw httpError(400, 'No Yahrzeits selected');
  const settings = getSettings(db);
  audit(db, req.user, 'print', 'yahrzeit_letters', null, { count: letters.length });
  if (req.body.format === 'docx') {
    res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment('yahrzeit-letters.docx');
    return res.send(await lettersDocx(settings, letters));
  }
  res.type('application/pdf').attachment('yahrzeit-letters.pdf').send(await lettersPdf(settings, letters));
});

router.post('/send-reminders', requirePermission('comms.send'), async (req, res) => {
  const db = req.app.get('db');
  const stats = await sendDueReminders(db);
  audit(db, req.user, 'send', 'reminders', null, stats);
  req.flash('success', `Reminders checked: ${stats.sent} sent, ${stats.failed} failed.`);
  res.redirect('/occasions');
});

function occasionValues(body) {
  return {
    type: oneOf(body.type, TYPES, 'other'),
    person_id: int(body.person_id),
    name: str(body.name),
    hebrew_name: str(body.hebrew_name),
    relationship: str(body.relationship),
    gregorian_date: date(body.gregorian_date),
    after_sunset: bool(body.after_sunset),
    observe: oneOf(body.observe, ['hebrew', 'gregorian'], 'hebrew'),
    remind: bool(body.remind),
    remind_days_before: Math.min(60, Math.max(0, int(body.remind_days_before, 7))),
    remind_email: bool(body.remind_email),
    remind_sms: bool(body.remind_sms),
    notes: str(body.notes),
  };
}

router.get('/new', requirePermission('occasions.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.query.family_id);
  const people = db.prepare('SELECT * FROM people WHERE family_id = ?').all(family.id);
  res.render('occasions/form', {
    title: 'New occasion', family, people, types: TYPES,
    occasion: { type: oneOf(req.query.type, TYPES, 'yahrzeit'), remind: 1, remind_days_before: 7, remind_email: 1, observe: 'hebrew' },
  });
});

router.post('/', requirePermission('occasions.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.body.family_id);
  const v = occasionValues(req.body);
  if (!v.name || !v.gregorian_date) throw httpError(400, 'Name and date are required');
  const cols = Object.keys(v);
  const { lastInsertRowid } = db.prepare(`INSERT INTO occasions (family_id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`).run(family.id, ...Object.values(v));
  audit(db, req.user, 'create', 'occasion', lastInsertRowid);
  req.flash('success', `${OCCASION_LABELS[v.type]} added.`);
  res.redirect(`/families/${family.id}`);
});

router.get('/:id/edit', requirePermission('occasions.write'), (req, res) => {
  const db = req.app.get('db');
  const occasion = mustGet(db, 'occasions', req.params.id);
  const family = mustGet(db, 'families', occasion.family_id);
  const people = db.prepare('SELECT * FROM people WHERE family_id = ?').all(family.id);
  res.render('occasions/form', { title: 'Edit occasion', family, people, types: TYPES, occasion });
});

router.post('/:id', requirePermission('occasions.write'), (req, res) => {
  const db = req.app.get('db');
  const occasion = mustGet(db, 'occasions', req.params.id);
  const v = occasionValues(req.body);
  if (!v.name || !v.gregorian_date) throw httpError(400, 'Name and date are required');
  db.prepare(`UPDATE occasions SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), occasion.id);
  audit(db, req.user, 'update', 'occasion', occasion.id);
  req.flash('success', 'Occasion saved.');
  res.redirect(`/families/${occasion.family_id}`);
});

router.post('/:id/delete', requirePermission('occasions.write'), (req, res) => {
  const db = req.app.get('db');
  const occasion = mustGet(db, 'occasions', req.params.id);
  db.prepare('DELETE FROM occasions WHERE id = ?').run(occasion.id);
  audit(db, req.user, 'delete', 'occasion', occasion.id);
  req.flash('success', 'Occasion deleted.');
  res.redirect(`/families/${occasion.family_id}`);
});

export default router;
