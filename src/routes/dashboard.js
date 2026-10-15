import express from 'express';
import { can } from '../lib/permissions.js';
import { upcomingOccasions } from '../lib/occasions.js';
import { toHebrew, formatHebrew, todayISO } from '../lib/hebrew.js';
import { findFamilies } from '../lib/contactQuery.js';
import { attendance } from './events.js';

const router = express.Router();

router.get('/', (req, res) => {
  const db = req.app.get('db');
  const today = todayISO();
  const data = {
    title: 'Dashboard',
    today,
    todayHebrew: formatHebrew(toHebrew(today)),
    stats: {
      families: db.prepare('SELECT COUNT(*) n FROM families').get().n,
      people: db.prepare('SELECT COUNT(*) n FROM people').get().n,
    },
  };
  if (can(req.user, 'occasions.read')) data.occasions = upcomingOccasions(db, { days: 14 });
  if (can(req.user, 'events.read')) {
    data.events = db.prepare('SELECT * FROM events WHERE substr(starts_at,1,10) >= ? ORDER BY starts_at LIMIT 5').all(today)
      .map((e) => ({ ...e, att: attendance(db, e.id) }));
  }
  if (can(req.user, 'finance.read')) {
    const year = today.slice(0, 4);
    data.stats.ytd = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE kind = 'donation' AND date >= ?").get(`${year}-01-01`).t;
    data.stats.month = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE kind = 'donation' AND date >= ?").get(`${today.slice(0, 7)}-01`).t;
    data.stats.unthanked = db.prepare("SELECT COUNT(*) n FROM payments WHERE kind = 'donation' AND thanked_at IS NULL AND family_id IS NOT NULL").get().n;
  }
  res.render('dashboard', data);
});

// Global quick search used by the header search box.
router.get('/search', (req, res) => {
  const db = req.app.get('db');
  const q = String(req.query.q || '').trim();
  if (!q) return res.redirect('/families');
  const { rows } = findFamilies(db, { q }, { limit: 2 });
  if (rows.length === 1) return res.redirect(`/families/${rows[0].id}`);
  res.redirect(`/families?q=${encodeURIComponent(q)}`);
});

export default router;
