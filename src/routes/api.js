// JSON endpoints used by the UI (logged-in users only).
import express from 'express';
import { can } from '../lib/permissions.js';
import { lookupCep } from '../lib/viacep.js';
import { findFamilies } from '../lib/contactQuery.js';
import { toHebrew, formatHebrew, fromHebrew, nextOccurrence, todayISO, daysBetween, OCCASION_LABELS } from '../lib/hebrew.js';
import { date, bool, int, oneOf } from '../lib/forms.js';

const router = express.Router();

router.get('/cep/:cep', async (req, res) => {
  try {
    const r = await lookupCep(req.params.cep);
    res.status(r.error ? 404 : 200).json(r);
  } catch {
    res.status(502).json({ error: 'CEP lookup is unavailable right now' });
  }
});

router.get('/families', (req, res) => {
  if (!can(req.user, 'contacts.read')) return res.status(403).json({ error: 'Forbidden' });
  const db = req.app.get('db');
  const { rows } = findFamilies(db, { q: req.query.q }, { limit: 15 });
  res.json(rows.map((f) => ({ id: f.id, family_name: f.family_name, salutation: f.salutation, city: f.city, email: f.email })));
});

router.get('/hebrew-date', (req, res) => {
  if (!date(req.query.date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  res.json(formatHebrew(toHebrew(req.query.date, bool(req.query.after_sunset))));
});

// Hebrew date -> civil date, e.g. ?day=24&month=Tishrei&year=5786
router.get('/from-hebrew', (req, res) => {
  const day = int(req.query.day);
  const year = int(req.query.year);
  if (!day || !year || !req.query.month) return res.status(400).json({ error: 'day, month and year are required' });
  try {
    const iso = fromHebrew(day, req.query.month, year);
    res.json({ date: iso, hebrew: formatHebrew(toHebrew(iso)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Next observance for an occasion being entered, so the form can show it before saving.
router.get('/next-occurrence', (req, res) => {
  if (!date(req.query.date)) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });
  const occ = {
    type: oneOf(req.query.type, Object.keys(OCCASION_LABELS), 'yahrzeit'),
    gregorian_date: req.query.date,
    after_sunset: bool(req.query.after_sunset),
    observe: oneOf(req.query.observe, ['hebrew', 'gregorian'], 'hebrew'),
  };
  const today = todayISO();
  const next = nextOccurrence(occ, today);
  res.json({
    original: formatHebrew(toHebrew(occ.gregorian_date, occ.after_sunset)),
    next: next && { date: next.date, hebrew: next.hebrew, count: next.count, daysAway: daysBetween(today, next.date) },
  });
});

export default router;
