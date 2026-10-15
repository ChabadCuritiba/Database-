import express from 'express';
import { requirePermission } from '../lib/permissions.js';
import { categoryTree } from '../lib/contactQuery.js';
import { audit } from '../lib/audit.js';
import { str, int, mustGet, httpError } from '../lib/forms.js';

const router = express.Router();

router.get('/', requirePermission('contacts.read'), (req, res) => {
  const db = req.app.get('db');
  const counts = Object.fromEntries(
    db.prepare('SELECT category_id, COUNT(*) n FROM family_categories GROUP BY category_id').all().map((r) => [r.category_id, r.n]),
  );
  res.render('categories/index', { title: 'Categories', tree: categoryTree(db), counts });
});

router.post('/', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const name = str(req.body.name);
  if (!name) throw httpError(400, 'Name is required');
  const parent = int(req.body.parent_id);
  if (db.prepare('SELECT 1 FROM categories WHERE name = ? AND parent_id IS ?').get(name, parent)) throw httpError(400, 'That category already exists');
  const { lastInsertRowid } = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(name, parent);
  audit(db, req.user, 'create', 'category', lastInsertRowid, name);
  req.flash('success', `Category "${name}" created.`);
  res.redirect('/categories');
});

router.post('/:id', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const cat = mustGet(db, 'categories', req.params.id);
  const name = str(req.body.name) || cat.name;
  let parent = int(req.body.parent_id);
  // Prevent cycles: the new parent may not be the category itself or one of its descendants.
  const descendants = new Set(
    db.prepare('WITH RECURSIVE t(id) AS (SELECT ? UNION ALL SELECT c.id FROM categories c JOIN t ON c.parent_id = t.id) SELECT id FROM t').all(cat.id).map((r) => r.id),
  );
  if (parent && descendants.has(parent)) throw httpError(400, 'A category cannot be moved inside itself');
  db.prepare('UPDATE categories SET name = ?, parent_id = ? WHERE id = ?').run(name, parent, cat.id);
  audit(db, req.user, 'update', 'category', cat.id, name);
  req.flash('success', 'Category saved.');
  res.redirect('/categories');
});

router.post('/:id/delete', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const cat = mustGet(db, 'categories', req.params.id);
  db.prepare('DELETE FROM categories WHERE id = ?').run(cat.id);
  audit(db, req.user, 'delete', 'category', cat.id, cat.name);
  req.flash('success', `Category "${cat.name}" and its sub-categories deleted.`);
  res.redirect('/categories');
});

export default router;
