// JSON endpoints used by the UI (logged-in users only).
import express from 'express';
import { can } from '../lib/permissions.js';
import { lookupCep } from '../lib/viacep.js';
import { findFamilies } from '../lib/contactQuery.js';
import { toHebrew, formatHebrew } from '../lib/hebrew.js';
import { date, bool } from '../lib/forms.js';

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

export default router;
