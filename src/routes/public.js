// Public pages (no login): event sign-up and online donations.
import express from 'express';
import { createCheckout, onlinePaymentsEnabled } from '../lib/stripe.js';
import { registrationTotal } from '../lib/finance.js';
import { parseMoney } from '../lib/format.js';
import { attendance } from './events.js';
import { str, int, httpError } from '../lib/forms.js';

const router = express.Router();

/** Find an existing family by email so public sign-ups link to the right record. */
export function familyIdByEmail(db, email) {
  if (!email) return null;
  const row = db.prepare('SELECT id FROM families WHERE email = ? COLLATE NOCASE').get(email)
    || db.prepare('SELECT family_id id FROM people WHERE email = ? COLLATE NOCASE').get(email);
  return row?.id ?? null;
}

function openEvent(db, slug) {
  const event = db.prepare('SELECT * FROM events WHERE slug = ?').get(slug);
  if (!event || !event.open) throw httpError(404, 'This event is not open for registration.');
  return event;
}

function spotsLeft(db, event) {
  return event.capacity ? Math.max(0, event.capacity - attendance(db, event.id).people) : null;
}

router.get('/e/:slug', (req, res) => {
  const db = req.app.get('db');
  const event = openEvent(db, req.params.slug);
  res.render('public/event', { title: event.name, event, left: spotsLeft(db, event), online: onlinePaymentsEnabled(), layout: 'public' });
});

router.post('/e/:slug', async (req, res) => {
  const db = req.app.get('db');
  const event = openEvent(db, req.params.slug);
  const counts = {
    adults: Math.max(0, int(req.body.adults, 0)),
    students: Math.max(0, int(req.body.students, 0)),
    children: Math.max(0, int(req.body.children, 0)),
  };
  const people = counts.adults + counts.students + counts.children;
  const name = str(req.body.name);
  const email = str(req.body.email);
  if (!name || !email || people <= 0) throw httpError(400, 'Please enter your name, email and at least one attendee.');
  if (people > 50) throw httpError(400, 'For groups larger than 50 please contact us.');
  const left = spotsLeft(db, event);
  if (left !== null && people > left) throw httpError(400, left ? `Only ${left} spots are left.` : 'Sorry, this event is full.');
  const total = registrationTotal(event, counts);
  const { lastInsertRowid: id } = db.prepare(
    'INSERT INTO registrations (event_id, family_id, name, email, phone, adults, students, children, total, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(event.id, familyIdByEmail(db, email), name, email, str(req.body.phone), counts.adults, counts.students, counts.children, total, total > 0 ? 'pending' : 'free', str(req.body.notes));

  if (total > 0 && onlinePaymentsEnabled() && req.body.pay_later !== '1') {
    const url = await createCheckout({
      amount: total, description: event.name, email,
      metadata: { kind: 'registration', ref_id: id }, successPath: `/e/${event.slug}/done`, cancelPath: `/e/${event.slug}`,
    });
    return res.redirect(303, url);
  }
  res.redirect(`/e/${event.slug}/done`);
});

router.get('/e/:slug/done', (req, res) => {
  const event = req.app.get('db').prepare('SELECT * FROM events WHERE slug = ?').get(req.params.slug);
  if (!event) throw httpError(404, 'Event not found');
  res.render('public/done', { title: 'Registration received', event, layout: 'public' });
});

router.get('/donate', (req, res) => {
  const db = req.app.get('db');
  if (!onlinePaymentsEnabled()) throw httpError(404, 'Online donations are not available.');
  const funds = db.prepare('SELECT * FROM funds WHERE active = 1 ORDER BY name').all();
  res.render('public/donate', { title: 'Donate', funds, fundId: int(req.query.fund), layout: 'public' });
});

router.post('/donate', async (req, res) => {
  const db = req.app.get('db');
  if (!onlinePaymentsEnabled()) throw httpError(404, 'Online donations are not available.');
  const amount = parseMoney(req.body.amount === 'other' ? req.body.other_amount : req.body.amount);
  const fund = db.prepare('SELECT * FROM funds WHERE id = ? AND active = 1').get(int(req.body.fund_id));
  const email = str(req.body.email);
  if (amount < 100) throw httpError(400, 'Please enter an amount.');
  if (!fund || !email || !str(req.body.name)) throw httpError(400, 'Please fill in your name, email and fund.');
  const url = await createCheckout({
    amount, description: `Donation – ${fund.name}`, email,
    metadata: { kind: 'donation', fund_id: fund.id, name: str(req.body.name), dedication: str(req.body.dedication) },
    successPath: '/thank-you', cancelPath: '/donate',
  });
  res.redirect(303, url);
});

router.get('/thank-you', (req, res) => res.render('public/thanks', { title: 'Thank you', layout: 'public' }));

export default router;
