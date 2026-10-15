// Builds family searches from a criteria object. Used by the contact list,
// mailings, labels and campaigns so every list is filtered the same way.
//
// criteria = {
//   q,              free text (family name, people names, email, phone)
//   categories,     array of category ids (sub-categories are included)
//   categoryMode,   'any' (default) | 'all'
//   priorityMax,    1..5 (1 = highest)
//   affiliation, source, city, state
//   require,        'email' | 'mobile' | 'address' -- also honours opt-outs
//   donatedSince,   YYYY-MM-DD  only families with a donation on/after
//   notDonatedSince YYYY-MM-DD  only families without a donation on/after
// }

const descendantsSql = `
  WITH RECURSIVE tree(id) AS (
    SELECT id FROM categories WHERE id = ?
    UNION ALL
    SELECT c.id FROM categories c JOIN tree t ON c.parent_id = t.id
  ) SELECT id FROM tree`;

export function normalizeCriteria(input = {}) {
  const arr = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]);
  return {
    q: (input.q || '').trim(),
    categories: arr(input.categories).map(Number).filter(Boolean),
    categoryMode: input.categoryMode === 'all' ? 'all' : 'any',
    priorityMax: Number(input.priorityMax) || null,
    affiliation: (input.affiliation || '').trim(),
    source: (input.source || '').trim(),
    city: (input.city || '').trim(),
    state: (input.state || '').trim(),
    require: ['email', 'mobile', 'address'].includes(input.require) ? input.require : '',
    donatedSince: input.donatedSince || '',
    notDonatedSince: input.notDonatedSince || '',
  };
}

export function buildFamilyQuery(db, rawCriteria, { orderBy = 'f.family_name COLLATE NOCASE', limit, offset } = {}) {
  const c = normalizeCriteria(rawCriteria);
  const where = [];
  const params = [];

  if (c.q) {
    const like = `%${c.q}%`;
    where.push(`(f.family_name LIKE ? OR f.salutation LIKE ? OR f.email LIKE ? OR f.phone LIKE ? OR f.mobile LIKE ?
      OR EXISTS (SELECT 1 FROM people p WHERE p.family_id = f.id
                 AND (p.first_name || ' ' || COALESCE(p.last_name,'') LIKE ? OR p.hebrew_name LIKE ? OR p.email LIKE ?)))`);
    params.push(like, like, like, like, like, like, like, like);
  }

  if (c.categories.length) {
    const descend = db.prepare(descendantsSql);
    // A deleted category id matches nothing rather than producing "IN ()".
    const groups = c.categories.map((id) => descend.all(id).map((r) => r.id)).map((g) => (g.length ? g : [-1]));
    const clauses = groups.map((ids) => {
      params.push(...ids);
      return `EXISTS (SELECT 1 FROM family_categories fc WHERE fc.family_id = f.id AND fc.category_id IN (${ids.map(() => '?').join(',')}))`;
    });
    where.push(`(${clauses.join(c.categoryMode === 'all' ? ' AND ' : ' OR ')})`);
  }

  if (c.priorityMax) { where.push('f.priority <= ?'); params.push(c.priorityMax); }
  for (const field of ['affiliation', 'source', 'city', 'state']) {
    if (c[field]) { where.push(`f.${field} = ? COLLATE NOCASE`); params.push(c[field]); }
  }

  if (c.require === 'email') where.push("f.no_email = 0 AND COALESCE(f.email,'') <> ''");
  if (c.require === 'mobile') where.push("f.no_sms = 0 AND COALESCE(f.mobile,'') <> ''");
  if (c.require === 'address') where.push("f.no_mail = 0 AND COALESCE(f.street,'') <> '' AND COALESCE(f.city,'') <> ''");

  if (c.donatedSince) {
    where.push("EXISTS (SELECT 1 FROM payments p WHERE p.family_id = f.id AND p.kind = 'donation' AND p.date >= ?)");
    params.push(c.donatedSince);
  }
  if (c.notDonatedSince) {
    where.push("NOT EXISTS (SELECT 1 FROM payments p WHERE p.family_id = f.id AND p.kind = 'donation' AND p.date >= ?)");
    params.push(c.notDonatedSince);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let sql = `SELECT f.* FROM families f ${whereSql} ORDER BY ${orderBy}`;
  const pageParams = [...params];
  if (limit) { sql += ' LIMIT ? OFFSET ?'; pageParams.push(limit, offset || 0); }
  return {
    sql,
    params: pageParams,
    countSql: `SELECT COUNT(*) n FROM families f ${whereSql}`,
    countParams: params,
    criteria: c,
  };
}

export function findFamilies(db, criteria, opts) {
  const q = buildFamilyQuery(db, criteria, opts);
  return { rows: db.prepare(q.sql).all(...q.params), total: db.prepare(q.countSql).get(...q.countParams).n, criteria: q.criteria };
}

/** Category tree as a flat list with depth and full path, ordered for display. */
export function categoryTree(db) {
  const rows = db.prepare('SELECT * FROM categories ORDER BY name COLLATE NOCASE').all();
  const byParent = new Map();
  for (const r of rows) {
    const k = r.parent_id ?? 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(r);
  }
  const out = [];
  const walk = (parent, depth, prefix) => {
    for (const r of byParent.get(parent) || []) {
      const path = prefix ? `${prefix} › ${r.name}` : r.name;
      out.push({ ...r, depth, path });
      walk(r.id, depth + 1, path);
    }
  };
  walk(0, 0, '');
  return out;
}
