import express from 'express';
import { can, requirePermission, CONTACT_INFO_FIELDS } from '../lib/permissions.js';
import { findFamilies, categoryTree } from '../lib/contactQuery.js';
import { nextOccurrence } from '../lib/hebrew.js';
import { openPledges, splitsFor, orderTotal, amountPaid } from '../lib/finance.js';
import { audit } from '../lib/audit.js';
import { str, bool, int, date, ids, oneOf, mustGet, toCsv, httpError } from '../lib/forms.js';
import { formatAddress } from '../lib/format.js';

const router = express.Router();
const PAGE = 50;

const FAMILY_FIELDS = [
  'family_name', 'salutation', 'hebrew_name', 'affiliation', 'source', 'tax_id', 'notes', ...CONTACT_INFO_FIELDS,
];
const PERSON_RELATIONS = ['primary', 'spouse', 'child', 'parent', 'other'];

function customFieldDefs(res) {
  try { return JSON.parse(res.locals.settings.custom_field_defs || '[]'); } catch { return []; }
}

function familyValues(body, defs) {
  const v = {};
  for (const f of FAMILY_FIELDS) v[f] = str(body[f]);
  v.priority = Math.min(5, Math.max(1, int(body.priority, 3)));
  v.no_mail = bool(body.no_mail);
  v.no_email = bool(body.no_email);
  v.no_sms = bool(body.no_sms);
  v.cep = v.cep ? v.cep.replace(/\D/g, '') : null;
  const custom = {};
  for (const d of defs) if (str(body[`custom_${d.key}`])) custom[d.key] = str(body[`custom_${d.key}`]);
  v.custom_fields = JSON.stringify(custom);
  return v;
}

function distinct(db, col) {
  return db.prepare(`SELECT DISTINCT ${col} v FROM families WHERE COALESCE(${col},'') <> '' ORDER BY 1`).all().map((r) => r.v);
}

router.get('/', requirePermission('contacts.read'), (req, res) => {
  const db = req.app.get('db');
  const page = Math.max(1, int(req.query.page, 1));
  const { rows, total, criteria } = findFamilies(db, req.query, { limit: PAGE, offset: (page - 1) * PAGE });
  const qs = new URLSearchParams(Object.entries(req.query).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]])).filter(([k]) => k !== 'page')).toString();
  res.render('families/index', {
    title: 'Contacts', rows, total, page, pages: Math.ceil(total / PAGE), criteria, qs,
    categories: categoryTree(db), affiliations: distinct(db, 'affiliation'), sources: distinct(db, 'source'), cities: distinct(db, 'city'),
  });
});

router.get('/export.csv', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const { rows } = findFamilies(db, req.query);
  const cats = db.prepare('SELECT c.name FROM family_categories fc JOIN categories c ON c.id = fc.category_id WHERE fc.family_id = ?');
  const people = db.prepare("SELECT first_name, last_name, relation FROM people WHERE family_id = ? ORDER BY relation = 'primary' DESC, id");
  const csv = toCsv(rows, [
    { label: 'ID', key: 'id' }, { label: 'Family', key: 'family_name' }, { label: 'Salutation', key: 'salutation' },
    { label: 'People', value: (r) => people.all(r.id).map((p) => `${p.first_name} ${p.last_name || ''} (${p.relation})`.trim()).join('; ') },
    { label: 'Email', key: 'email' }, { label: 'Phone', key: 'phone' }, { label: 'Mobile', key: 'mobile' },
    { label: 'Address', value: (r) => formatAddress(r).join(', ') }, { label: 'City', key: 'city' }, { label: 'State', key: 'state' },
    { label: 'CEP', key: 'cep' }, { label: 'Affiliation', key: 'affiliation' }, { label: 'Priority', key: 'priority' },
    { label: 'Source', key: 'source' }, { label: 'Categories', value: (r) => cats.all(r.id).map((c) => c.name).join('; ') },
  ]);
  audit(db, req.user, 'export', 'families', null, { count: rows.length });
  res.type('text/csv').attachment('contacts.csv').send(csv);
});

// Bulk-tag the families matching a search.
router.post('/bulk-categorize', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const familyIds = ids(req.body.family_ids);
  const categoryId = int(req.body.category_id);
  if (!categoryId || !familyIds.length) throw httpError(400, 'Choose a category and at least one contact');
  const ins = db.prepare('INSERT OR IGNORE INTO family_categories (family_id, category_id) VALUES (?, ?)');
  db.transaction(() => familyIds.forEach((f) => ins.run(f, categoryId)))();
  req.flash('success', `Tagged ${familyIds.length} contacts.`);
  res.redirect('/families');
});

router.get('/new', requirePermission('contacts.write'), (req, res) => {
  res.render('families/form', { title: 'New contact', family: { priority: 3, country: 'Brasil', custom_fields: '{}' }, defs: customFieldDefs(res), limited: false });
});

router.post('/', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const v = familyValues(req.body, customFieldDefs(res));
  if (!v.family_name) throw httpError(400, 'Family name is required');
  const cols = Object.keys(v);
  const { lastInsertRowid: id } = db.prepare(`INSERT INTO families (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(v));
  // Optionally create the primary person in the same step.
  if (str(req.body.first_name)) {
    db.prepare("INSERT INTO people (family_id, relation, first_name, last_name, email, mobile) VALUES (?, 'primary', ?, ?, ?, ?)").run(
      id, str(req.body.first_name), v.family_name, v.email, v.mobile,
    );
  }
  audit(db, req.user, 'create', 'family', id);
  req.flash('success', 'Contact created.');
  res.redirect(`/families/${id}`);
});

router.get('/:id', requirePermission('contacts.read'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  const people = db.prepare("SELECT * FROM people WHERE family_id = ? ORDER BY CASE relation WHEN 'primary' THEN 0 WHEN 'spouse' THEN 1 WHEN 'child' THEN 2 ELSE 3 END, birth_date").all(family.id);
  const categories = db.prepare('SELECT c.* FROM family_categories fc JOIN categories c ON c.id = fc.category_id WHERE fc.family_id = ?').all(family.id);
  const occasions = db.prepare('SELECT * FROM occasions WHERE family_id = ? ORDER BY type, name').all(family.id).map((o) => ({ ...o, next: nextOccurrence(o) }));
  const data = { title: family.family_name, family, people, categories, occasions, tree: categoryTree(db), defs: customFieldDefs(res) };
  data.custom = JSON.parse(family.custom_fields || '{}');

  if (can(req.user, 'finance.read')) {
    data.donations = db.prepare("SELECT * FROM payments WHERE family_id = ? AND kind = 'donation' ORDER BY date DESC LIMIT 50").all(family.id)
      .map((p) => ({ ...p, splits: splitsFor(db, p.id) }));
    data.pledges = openPledges(db, family.id);
    data.givingByYear = db.prepare("SELECT substr(date,1,4) year, SUM(amount) total FROM payments WHERE family_id = ? AND kind = 'donation' GROUP BY 1 ORDER BY 1 DESC").all(family.id);
  }
  if (can(req.user, 'orders.read')) {
    data.orders = db.prepare('SELECT * FROM orders WHERE family_id = ? ORDER BY date DESC').all(family.id)
      .map((o) => ({ ...o, total: orderTotal(db, o.id), paid: amountPaid(db, 'order', o.id) }));
  }
  if (can(req.user, 'events.read')) {
    data.registrations = db.prepare('SELECT r.*, e.name event_name, e.starts_at FROM registrations r JOIN events e ON e.id = r.event_id WHERE r.family_id = ? ORDER BY e.starts_at DESC').all(family.id);
  }
  res.render('families/show', data);
});

router.get('/:id/edit', requirePermission('contacts.contact_info'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  res.render('families/form', { title: `Edit ${family.family_name}`, family, defs: customFieldDefs(res), limited: !can(req.user, 'contacts.write') });
});

router.post('/:id', requirePermission('contacts.contact_info'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  let v = familyValues(req.body, customFieldDefs(res));
  // Volunteers may only change phone / address / email.
  if (!can(req.user, 'contacts.write')) v = Object.fromEntries(CONTACT_INFO_FIELDS.map((f) => [f, v[f]]));
  else if (!v.family_name) throw httpError(400, 'Family name is required');
  const changed = Object.keys(v).filter((k) => (family[k] ?? null) !== (v[k] ?? null));
  if (changed.length) {
    db.prepare(`UPDATE families SET ${changed.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...changed.map((k) => v[k]), family.id);
    audit(db, req.user, 'update', 'family', family.id, { fields: changed });
  }
  req.flash('success', 'Contact saved.');
  res.redirect(`/families/${family.id}`);
});

router.post('/:id/delete', requirePermission('admin'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  db.prepare('DELETE FROM families WHERE id = ?').run(family.id);
  audit(db, req.user, 'delete', 'family', family.id, family.family_name);
  req.flash('success', `${family.family_name} deleted.`);
  res.redirect('/families');
});

router.post('/:id/categories', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  const chosen = ids(req.body.categories);
  db.transaction(() => {
    db.prepare('DELETE FROM family_categories WHERE family_id = ?').run(family.id);
    const ins = db.prepare('INSERT OR IGNORE INTO family_categories (family_id, category_id) VALUES (?, ?)');
    for (const c of chosen) ins.run(family.id, c);
  })();
  audit(db, req.user, 'categorize', 'family', family.id, chosen);
  req.flash('success', 'Categories updated.');
  res.redirect(`/families/${family.id}`);
});

// --- People (spouse, children, extended family) ---

function personValues(body) {
  return {
    relation: oneOf(body.relation, PERSON_RELATIONS, 'other'),
    first_name: str(body.first_name),
    last_name: str(body.last_name),
    hebrew_name: str(body.hebrew_name),
    father_hebrew_name: str(body.father_hebrew_name),
    mother_hebrew_name: str(body.mother_hebrew_name),
    gender: oneOf(body.gender, ['M', 'F'], null),
    lineage: oneOf(body.lineage, ['kohen', 'levi', 'yisrael'], null),
    birth_date: date(body.birth_date),
    birth_after_sunset: bool(body.birth_after_sunset),
    email: str(body.email),
    mobile: str(body.mobile),
    deceased: bool(body.deceased),
    notes: str(body.notes),
  };
}

router.get('/:id/people/new', requirePermission('contacts.write'), (req, res) => {
  const family = mustGet(req.app.get('db'), 'families', req.params.id);
  res.render('families/person', { title: 'Add person', family, person: { relation: req.query.relation || 'child', last_name: family.family_name } });
});

router.post('/:id/people', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  const v = personValues(req.body);
  if (!v.first_name) throw httpError(400, 'First name is required');
  const cols = Object.keys(v);
  const { lastInsertRowid: pid } = db.prepare(`INSERT INTO people (family_id, ${cols.join(',')}) VALUES (?, ${cols.map(() => '?').join(',')})`).run(family.id, ...Object.values(v));
  if (v.birth_date && bool(req.body.track_birthday)) addBirthday(db, family.id, pid, v);
  audit(db, req.user, 'create', 'person', pid);
  req.flash('success', `${v.first_name} added.`);
  res.redirect(`/families/${family.id}`);
});

function addBirthday(db, familyId, personId, p) {
  db.prepare(`INSERT INTO occasions (family_id, person_id, type, name, hebrew_name, gregorian_date, after_sunset, remind_days_before)
              VALUES (?, ?, 'birthday', ?, ?, ?, ?, 3)`).run(familyId, personId, `${p.first_name} ${p.last_name || ''}`.trim(), p.hebrew_name, p.birth_date, p.birth_after_sunset);
}

router.get('/:id/people/:pid/edit', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.params.id);
  const person = mustGet(db, 'people', req.params.pid);
  if (person.family_id !== family.id) throw httpError(404, 'Person not found');
  res.render('families/person', { title: `Edit ${person.first_name}`, family, person });
});

router.post('/:id/people/:pid', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const person = mustGet(db, 'people', req.params.pid);
  if (person.family_id !== Number(req.params.id)) throw httpError(404, 'Person not found');
  const v = personValues(req.body);
  if (!v.first_name) throw httpError(400, 'First name is required');
  db.prepare(`UPDATE people SET ${Object.keys(v).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...Object.values(v), person.id);
  audit(db, req.user, 'update', 'person', person.id);
  req.flash('success', 'Person saved.');
  res.redirect(`/families/${person.family_id}`);
});

router.post('/:id/people/:pid/delete', requirePermission('contacts.write'), (req, res) => {
  const db = req.app.get('db');
  const person = mustGet(db, 'people', req.params.pid);
  if (person.family_id !== Number(req.params.id)) throw httpError(404, 'Person not found');
  db.prepare('DELETE FROM people WHERE id = ?').run(person.id);
  audit(db, req.user, 'delete', 'person', person.id);
  req.flash('success', 'Person removed.');
  res.redirect(`/families/${person.family_id}`);
});

export default router;
