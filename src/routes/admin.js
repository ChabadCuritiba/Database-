import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { requirePermission, ROLES } from '../lib/permissions.js';
import { getSettings, setSetting } from '../db/index.js';
import { runBackup, listBackups } from '../lib/backup.js';
import { audit } from '../lib/audit.js';
import { config } from '../config.js';
import { str, bool, oneOf, mustGet, httpError } from '../lib/forms.js';

const router = express.Router();
router.use(requirePermission('admin'));

const EDITABLE_SETTINGS = [
  'org_name', 'org_address', 'org_tax_id', 'org_phone', 'org_email', 'signature_name', 'signature_title',
  'receipt_footer', 'thank_you_body', 'yahrzeit_body', 'reminder_email_subject', 'reminder_body',
];

router.get('/', (req, res) => res.redirect('/admin/users'));

router.get('/users', (req, res) => {
  const db = req.app.get('db');
  res.render('admin/users', { title: 'Users & roles', users: db.prepare('SELECT * FROM users ORDER BY active DESC, email').all(), roles: ROLES });
});

router.post('/users', (req, res) => {
  const db = req.app.get('db');
  const email = str(req.body.email)?.toLowerCase();
  if (!email || !email.includes('@')) throw httpError(400, 'A valid email is required');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(400, 'That user already exists');
  const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(email, str(req.body.name), oneOf(req.body.role, ROLES, 'volunteer'));
  audit(db, req.user, 'invite', 'user', lastInsertRowid, { email, role: req.body.role });
  req.flash('success', `${email} can now sign in with Google.`);
  res.redirect('/admin/users');
});

router.post('/users/:id', (req, res) => {
  const db = req.app.get('db');
  const u = mustGet(db, 'users', req.params.id);
  const role = oneOf(req.body.role, ROLES, u.role);
  const active = bool(req.body.active);
  if (u.id === req.user.id && (role !== 'admin' || !active)) throw httpError(400, 'You cannot remove your own admin access');
  db.prepare('UPDATE users SET role = ?, active = ?, name = COALESCE(?, name) WHERE id = ?').run(role, active, str(req.body.name), u.id);
  audit(db, req.user, 'update', 'user', u.id, { role, active });
  req.flash('success', `${u.email} updated.`);
  res.redirect('/admin/users');
});

router.get('/settings', (req, res) => {
  const settings = getSettings(req.app.get('db'));
  let defs = [];
  try { defs = JSON.parse(settings.custom_field_defs || '[]'); } catch { /* ignore */ }
  res.render('admin/settings', { title: 'Settings', s: settings, defs });
});

router.post('/settings', (req, res) => {
  const db = req.app.get('db');
  for (const k of EDITABLE_SETTINGS) if (k in req.body) setSetting(db, k, String(req.body[k] ?? '').replace(/\r\n/g, '\n'));
  // Custom contact fields, one per line: "key: Label" or just "Label".
  const defs = String(req.body.custom_fields || '')
    .split('\n').map((l) => l.trim()).filter(Boolean)
    .map((l) => {
      const [a, b] = l.includes(':') ? l.split(/:(.*)/s) : [l, l];
      const key = a.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      return { key, label: (b || a).trim() };
    })
    .filter((d) => d.key);
  setSetting(db, 'custom_field_defs', JSON.stringify(defs));
  audit(db, req.user, 'update', 'settings');
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
});

router.get('/backups', (req, res) => {
  res.render('admin/backups', { title: 'Backups', backups: listBackups(), cfg: config.backup });
});

router.post('/backups', async (req, res) => {
  const db = req.app.get('db');
  const r = await runBackup(db);
  audit(db, req.user, 'backup', null, null, r);
  req.flash('success', `Backup created: ${path.basename(r.file)}${r.uploaded ? ` (uploaded to ${r.uploaded})` : ''}`);
  res.redirect('/admin/backups');
});

router.get('/backups/:name', (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(config.backup.dir, name);
  if (!/^community-.*\.db$/.test(name) || !fs.existsSync(file)) throw httpError(404, 'Backup not found');
  audit(req.app.get('db'), req.user, 'download', 'backup', null, name);
  res.download(file);
});

router.get('/audit', (req, res) => {
  const db = req.app.get('db');
  const rows = db.prepare('SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 500').all();
  res.render('admin/audit', { title: 'Audit log', rows });
});

export default router;
