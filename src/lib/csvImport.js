// Contact import from CSV files (Excel, Google Sheets, other systems).
import { audit } from './audit.js';

/** Parses CSV text: quoted fields, "" escapes, CRLF, BOM; delimiter , ; or tab detected from the header. */
export function parseCsv(text) {
  text = String(text || '').replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (ch) => firstLine.split(ch).length - 1;
  const delim = [';', '\t', ','].reduce((best, ch) => (count(ch) > count(best) ? ch : best), ',');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return { delimiter: delim, header: (rows.shift() || []).map((h) => h.trim()), rows };
}

/** Contact fields a column can be imported into. */
export const FIELDS = {
  family_name: 'Family / last name',
  full_name: 'Full name (split into first and last)',
  first_name: 'First name',
  salutation: 'Salutation',
  hebrew_name: 'Hebrew name',
  email: 'Email',
  mobile: 'Mobile',
  phone: 'Phone',
  street: 'Street / address',
  number: 'Number',
  complement: 'Complement',
  neighborhood: 'Neighborhood',
  city: 'City',
  state: 'State',
  cep: 'CEP',
  country: 'Country',
  tax_id: 'CPF / CNPJ',
  affiliation: 'Affiliation',
  priority: 'Priority (1-5)',
  source: 'Source',
  categories: 'Categories (separated by ;)',
  notes: 'Notes',
  spouse: 'Spouse name',
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// Header names (Portuguese and English, already normalized) recognized for each field.
const ALIASES = {
  family_name: ['family', 'familia', 'family name', 'last name', 'lastname', 'surname', 'sobrenome', 'nome da familia', 'name of family'],
  full_name: ['name', 'nome', 'full name', 'nome completo', 'contact', 'contato', 'contact name'],
  first_name: ['first name', 'firstname', 'given name', 'primeiro nome', 'prenome'],
  salutation: ['salutation', 'saudacao', 'tratamento', 'greeting'],
  hebrew_name: ['hebrew name', 'nome hebraico', 'nome em hebraico'],
  email: ['email', 'e mail', 'mail', 'email address', 'endereco de email', 'correio eletronico'],
  mobile: ['mobile', 'cell', 'cellphone', 'cell phone', 'celular', 'whatsapp', 'telefone celular', 'mobile phone'],
  phone: ['phone', 'telephone', 'telefone', 'fone', 'home phone', 'telefone fixo', 'tel'],
  street: ['street', 'address', 'endereco', 'rua', 'logradouro', 'address 1', 'address line 1'],
  number: ['number', 'numero', 'no', 'n', 'num'],
  complement: ['complement', 'complemento', 'apt', 'apartment', 'address 2', 'address line 2'],
  neighborhood: ['neighborhood', 'neighbourhood', 'bairro', 'district'],
  city: ['city', 'cidade', 'municipio', 'town'],
  state: ['state', 'estado', 'uf', 'province'],
  cep: ['cep', 'zip', 'zip code', 'zipcode', 'postal code', 'postcode', 'codigo postal'],
  country: ['country', 'pais'],
  tax_id: ['cpf', 'cnpj', 'cpf cnpj', 'tax id', 'documento'],
  affiliation: ['affiliation', 'afiliacao', 'tipo', 'type', 'membership'],
  priority: ['priority', 'prioridade'],
  source: ['source', 'origem', 'fonte', 'como conheceu'],
  categories: ['categories', 'category', 'categorias', 'categoria', 'tags', 'tag', 'groups', 'grupos'],
  notes: ['notes', 'note', 'notas', 'observacoes', 'observacao', 'obs', 'comments', 'comentarios'],
  spouse: ['spouse', 'conjuge', 'esposa', 'esposo', 'marido', 'wife', 'husband'],
};

/** Suggests a field for each column header ('' = ignore the column). */
export function guessMapping(header) {
  const used = new Set();
  return header.map((h) => {
    const n = norm(h);
    for (const [field, names] of Object.entries(ALIASES)) {
      if (!used.has(field) && names.includes(n)) { used.add(field); return field; }
    }
    return '';
  });
}

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};

/** Turns one CSV row into contact values using the column mapping. */
export function rowToContact(row, mapping) {
  const v = {};
  mapping.forEach((field, i) => {
    if (!field || !FIELDS[field]) return;
    const val = clean(row[i]);
    if (val !== null && v[field] == null) v[field] = val;
  });
  if (v.full_name) {
    const parts = v.full_name.split(/\s+/);
    if (!v.first_name) v.first_name = parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0];
    if (!v.family_name) v.family_name = parts.length > 1 ? parts.at(-1) : parts[0];
  }
  delete v.full_name;
  if (v.email) v.email = v.email.toLowerCase();
  if (v.cep) v.cep = v.cep.replace(/\D/g, '') || null;
  if (v.priority) {
    const p = parseInt(v.priority, 10);
    v.priority = p >= 1 && p <= 5 ? p : null;
  }
  return v;
}

const FAMILY_COLUMNS = ['family_name', 'salutation', 'hebrew_name', 'email', 'mobile', 'phone', 'street', 'number', 'complement',
  'neighborhood', 'city', 'state', 'cep', 'country', 'tax_id', 'affiliation', 'priority', 'source', 'notes'];

function categoryId(db, name, cache) {
  const key = name.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  let row = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE ORDER BY parent_id IS NOT NULL LIMIT 1').get(name);
  if (!row) row = { id: Number(db.prepare('INSERT INTO categories (name) VALUES (?)').run(name).lastInsertRowid) };
  cache.set(key, row.id);
  return row.id;
}

/**
 * Imports parsed rows. options: { mapping, duplicates: 'skip' | 'update', categoryId, user }.
 * Duplicates are contacts with the same email. 'update' fills in fields that are empty today.
 * Returns { created, updated, skipped, errors: [{ row, message }] } (row = line number in the file).
 */
export function importContacts(db, rows, { mapping, duplicates = 'skip', categoryId: tagId = null, user = null }) {
  const result = { created: 0, updated: 0, skipped: 0, errors: [] };
  const byEmail = db.prepare('SELECT * FROM families WHERE email = ? COLLATE NOCASE');
  const tag = db.prepare('INSERT OR IGNORE INTO family_categories (family_id, category_id) VALUES (?, ?)');
  const person = db.prepare('INSERT INTO people (family_id, relation, first_name, last_name, email, mobile) VALUES (?, ?, ?, ?, ?, ?)');
  const catCache = new Map();

  db.transaction(() => {
    rows.forEach((row, index) => {
      const line = index + 2; // header is line 1
      const v = rowToContact(row, mapping);
      if (!v.family_name) {
        if (Object.keys(v).length) result.errors.push({ row: line, message: 'No name' });
        else result.skipped++;
        return;
      }
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) {
        result.errors.push({ row: line, message: `Invalid email "${v.email}"` });
        return;
      }
      const existing = v.email ? byEmail.get(v.email) : null;
      let familyId;
      if (existing) {
        if (duplicates !== 'update') { result.skipped++; return; }
        const fill = FAMILY_COLUMNS.filter((c) => v[c] != null && (existing[c] == null || existing[c] === ''));
        if (fill.length) {
          db.prepare(`UPDATE families SET ${fill.map((c) => `${c} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
            .run(...fill.map((c) => v[c]), existing.id);
        }
        familyId = existing.id;
        result.updated++;
      } else {
        const cols = FAMILY_COLUMNS.filter((c) => v[c] != null);
        familyId = Number(db.prepare(`INSERT INTO families (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => v[c])).lastInsertRowid);
        if (v.first_name) person.run(familyId, 'primary', v.first_name, v.family_name, v.email ?? null, v.mobile ?? null);
        if (v.spouse) {
          const parts = v.spouse.split(/\s+/);
          person.run(familyId, 'spouse', parts[0], parts.length > 1 ? parts.slice(1).join(' ') : v.family_name, null, null);
        }
        result.created++;
      }
      if (tagId) tag.run(familyId, tagId);
      for (const name of String(v.categories || '').split(/[;,|]/).map((s) => s.trim()).filter(Boolean)) {
        tag.run(familyId, categoryId(db, name, catCache));
      }
    });
  })();
  audit(db, user, 'import', 'families', null, { created: result.created, updated: result.updated, skipped: result.skipped, errors: result.errors.length });
  return result;
}
