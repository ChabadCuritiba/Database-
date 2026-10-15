import express from 'express';
import { can, requirePermission } from '../lib/permissions.js';
import { amountPaid, registrationTotal } from '../lib/finance.js';
import { parseMoney } from '../lib/format.js';
import { todayISO } from '../lib/hebrew.js';
import { audit } from '../lib/audit.js';
import { str, bool, int, oneOf, mustGet, httpError, toCsv } from '../lib/forms.js';

const router = express.Router();
const TYPES = ['dinner', 'class', 'lecture', 'shabbaton', 'holiday', 'other'];
const METHODS = ['cash', 'check', 'pix', 'card', 'transfer', 'online', 'other'];

router.use(requirePermission('events.read'));

export function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'event';
}

function uniqueSlug(db, base, exceptId = 0) {
  let slug = base;
  for (let i = 2; db.prepare('SELECT 1 FROM events WHERE slug = ? AND id <> ?').get(slug, exceptId); i++) slug = `${base}-${i}`;
  return slug;
}

export function attendance(db, eventId) {
  return db.prepare(`SELECT COUNT(*) registrations, COALESCE(SUM(adults),0) adults, COALESCE(SUM(students),0) students,
      COALESCE(SUM(children),0) children, COALESCE(SUM(adults+students+children),0) people, COALESCE(SUM(checked_in),0) checked_in
    FROM registrations WHERE event_id = ? AND status <> 'cancelled'`).get(eventId);
}

router.get('/', (req, res) => {
  const db = req.app.get('db');
  const past = req.query.past === '1';
  const events = db.prepare(`SELECT * FROM events WHERE substr(starts_at,1,10) ${past ? '<' : '>='} ? ORDER BY starts_at ${past ? 'DESC' : 'ASC'}`).all(todayISO())
    .map((e) => ({ ...e, att: attendance(db, e.id) }));
  res.render('events/index', { title: past ? 'Past events' : 'Upcoming events', events, past });
});

function eventValues(body) {
  return {
    name: str(body.name),
    type: oneOf(body.type, TYPES, 'other'),
    starts_at: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(body.starts_at || '') ? body.starts_at : null,
    location: str(body.location),
    description: str(body.description),
    price_adult: parseMoney(body.price_adult),
    price_student: parseMoney(body.price_student),
    price_child: parseMoney(body.price_child),
    capacity: int(body.capacity),
    open: bool(body.open),
  };
}

router.get('/new', requirePermission('events.write'), (req, res) => {
  res.render('events/form', { title: 'New event', event: { type: 'class', open: 1 }, types: TYPES });
});

router.post('/', requirePermission('events.write'), (req, res) => {
  const db = req.app.get('db');
  const v = eventValues(req.body);
  if (!v.name || !v.starts_at) throw httpError(400, 'Name and start time are required');
  v.slug = uniqueSlug(db, slugify(str(req.body.slug) || `${v.name}-${v.starts_at.slice(0, 10)}`));
  const cols = Object.keys(v);
  const { lastInsertRowid } = db.prepare(`INSERT INTO events (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(v));
  audit(db, req.user, 'create', 'event', lastInsertRowid);
  req.flash('success', 'Event created.');
  res.redirect(`/events/${lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const db = req.app.get('db');
  const event = mustGet(db, 'events', req.params.id);
  const regs = db.prepare('SELECT r.*, f.family_name FROM registrations r LEFT JOIN families f ON f.id = r.family_id WHERE r.event_id = ? ORDER BY r.status = \'cancelled\', r.name COLLATE NOCASE').all(event.id)
    .map((r) => ({ ...r, paid: amountPaid(db, 'registration', r.id) }));
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment(`${event.slug}.csv`).send(toCsv(regs, [
      { label: 'Name', key: 'name' }, { label: 'Email', key: 'email' }, { label: 'Phone', key: 'phone' },
      { label: 'Adults', key: 'adults' }, { label: 'Students', key: 'students' }, { label: 'Children', key: 'children' },
      { label: 'Status', key: 'status' }, { label: 'Total', value: (r) => (r.total / 100).toFixed(2) }, { label: 'Paid', value: (r) => (r.paid / 100).toFixed(2) },
      { label: 'Checked in', value: (r) => (r.checked_in ? 'yes' : '') }, { label: 'Notes', key: 'notes' },
    ]));
  }
  const revenue = regs.reduce((t, r) => t + r.paid, 0);
  res.render('events/show', { title: event.name, event, regs, att: attendance(db, event.id), revenue, methods: METHODS, showMoney: can(req.user, 'finance.read') || can(req.user, 'events.write') });
});

router.get('/:id/edit', requirePermission('events.write'), (req, res) => {
  const event = mustGet(req.app.get('db'), 'events', req.params.id);
  res.render('events/form', { title: `Edit ${event.name}`, event, types: TYPES });
});

router.post('/:id', requirePermission('events.write'), (req, res) => {
  const db = req.app.get('db');
  const event = mustGet(db, 'events', req.params.id);
  const v = eventValues(req.body);
  if (!v.name || !v.starts_at) throw httpError(400, 'Name and start time are required');
  v.slug = uniqueSlug(db, slugify(str(req.body.slug) || event.slug), event.id);
  db.prepare(`UPDATE events SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), event.id);
  audit(db, req.user, 'update', 'event', event.id);
  req.flash('success', 'Event saved.');
  res.redirect(`/events/${event.id}`);
});

router.post('/:id/registrations', requirePermission('events.write'), (req, res) => {
  const db = req.app.get('db');
  const event = mustGet(db, 'events', req.params.id);
  const familyId = int(req.body.family_id);
  const family = familyId ? mustGet(db, 'families', familyId) : null;
  const counts = { adults: int(req.body.adults, 0), students: int(req.body.students, 0), children: int(req.body.children, 0) };
  if (counts.adults + counts.students + counts.children <= 0) throw httpError(400, 'At least one attendee is required');
  const name = str(req.body.name) || family?.salutation || family?.family_name;
  if (!name) throw httpError(400, 'Name is required');
  const total = registrationTotal(event, counts);
  db.prepare('INSERT INTO registrations (event_id, family_id, name, email, phone, adults, students, children, total, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    event.id, family?.id ?? null, name, str(req.body.email) || family?.email || null, str(req.body.phone) || family?.mobile || null,
    counts.adults, counts.students, counts.children, total, total > 0 ? 'pending' : 'free', str(req.body.notes),
  );
  req.flash('success', `${name} registered.`);
  res.redirect(`/events/${event.id}`);
});

router.post('/:id/registrations/:rid/:action', requirePermission('events.write'), (req, res) => {
  const db = req.app.get('db');
  const reg = mustGet(db, 'registrations', req.params.rid);
  if (reg.event_id !== Number(req.params.id)) throw httpError(404, 'Registration not found');
  switch (req.params.action) {
    case 'checkin':
      db.prepare('UPDATE registrations SET checked_in = 1 - checked_in WHERE id = ?').run(reg.id);
      break;
    case 'cancel':
      db.prepare("UPDATE registrations SET status = 'cancelled' WHERE id = ?").run(reg.id);
      break;
    case 'pay': {
      const amount = parseMoney(req.body.amount) || reg.total - amountPaid(db, 'registration', reg.id);
      if (amount <= 0) throw httpError(400, 'Nothing to pay');
      db.prepare("INSERT INTO payments (family_id, kind, ref_id, date, amount, method, reference, created_by) VALUES (?, 'registration', ?, ?, ?, ?, ?, ?)").run(
        reg.family_id, reg.id, todayISO(), amount, oneOf(req.body.method, METHODS, 'cash'), str(req.body.reference), req.user.id,
      );
      if (amountPaid(db, 'registration', reg.id) >= reg.total) db.prepare("UPDATE registrations SET status = 'paid' WHERE id = ?").run(reg.id);
      break;
    }
    default:
      throw httpError(404, 'Unknown action');
  }
  audit(db, req.user, req.params.action, 'registration', reg.id);
  res.redirect(`/events/${reg.event_id}`);
});

export default router;
