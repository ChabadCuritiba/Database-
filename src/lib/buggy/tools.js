// The actions Buggy may take. Read tools run immediately; write tools only
// prepare a proposal that the user must confirm before it is executed.
import { can } from '../permissions.js';
import { findFamilies } from '../contactQuery.js';
import { recordDonation, generalFundId, openPledges } from '../finance.js';
import { upcomingOccasions } from '../occasions.js';
import { nextOccurrence, toHebrew, formatHebrew, fromHebrew, todayISO, HEBREW_MONTHS, OCCASION_LABELS } from '../hebrew.js';
import { formatMoney, parseMoney, salutationOf, formatAddress } from '../format.js';
import { audit } from '../audit.js';

const RELATIONS = ['primary', 'spouse', 'child', 'parent', 'other'];
const RELATION_PT = { primary: 'titular', spouse: 'cônjuge', child: 'filho(a)', parent: 'pai/mãe', other: 'outro' };
const METHODS = ['cash', 'check', 'pix', 'card', 'transfer', 'other'];
const METHOD_PT = { cash: 'dinheiro', check: 'cheque', pix: 'PIX', card: 'cartão', transfer: 'transferência', other: 'outro' };
const OCCASION_TYPES = Object.keys(OCCASION_LABELS);

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };

const clean = (v) => {
  const s = String(v ?? '').trim();
  return s ? s : null;
};
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);

function family(db, id) {
  const f = db.prepare('SELECT * FROM families WHERE id = ?').get(Number(id));
  if (!f) fail(`No contact with id ${id}. Search for the contact first.`);
  return f;
}

function brief(f) {
  return { id: f.id, family_name: f.family_name, salutation: f.salutation || null, email: f.email || null, mobile: f.mobile || null, city: f.city || null };
}

function findFund(db, name) {
  const funds = db.prepare('SELECT * FROM funds WHERE active = 1').all();
  if (!clean(name)) return funds.find((f) => f.id === generalFundId(db));
  const q = String(name).toLowerCase();
  return funds.find((f) => f.name.toLowerCase() === q)
    || funds.find((f) => f.name.toLowerCase().includes(q) || q.includes(f.name.toLowerCase()))
    || fail(`Unknown fund "${name}". Available funds: ${funds.map((f) => f.name).join(', ')}.`);
}

const S = (description, extra = {}) => ({ type: 'string', description, ...extra });
const N = (description) => ({ type: 'number', description });

export const TOOLS = [
  {
    name: 'search_contacts',
    kind: 'read',
    permission: 'contacts.read',
    description: 'Find contacts (families) by name, Hebrew name, email or phone. Always search before creating a contact or acting on one.',
    parameters: { type: 'object', properties: { query: S('Name, email or phone to look for') }, required: ['query'] },
    run(db, user, { query }) {
      const { rows, total } = findFamilies(db, { q: String(query || '') }, { limit: 10 });
      return { total, contacts: rows.map(brief) };
    },
  },
  {
    name: 'get_contact',
    kind: 'read',
    permission: 'contacts.read',
    description: 'Full details of one contact: address, family members, categories, occasions with the next observance date' +
      ' and, when the user may see finances, recent donations and open pledges.',
    parameters: { type: 'object', properties: { family_id: N('Contact id from search_contacts') }, required: ['family_id'] },
    run(db, user, { family_id }) {
      const f = family(db, family_id);
      const out = {
        ...brief(f), phone: f.phone || null, address: formatAddress(f).join(', ') || null, hebrew_name: f.hebrew_name || null,
        affiliation: f.affiliation || null, priority: f.priority, notes: f.notes || null,
        people: db.prepare('SELECT id, relation, first_name, last_name, hebrew_name, birth_date, email, mobile FROM people WHERE family_id = ?').all(f.id),
        categories: db.prepare('SELECT c.name FROM family_categories fc JOIN categories c ON c.id = fc.category_id WHERE fc.family_id = ?').all(f.id).map((c) => c.name),
        occasions: db.prepare('SELECT * FROM occasions WHERE family_id = ?').all(f.id).map((o) => {
          const n = nextOccurrence(o);
          return { type: o.type, name: o.name, original_date: o.gregorian_date, next_date: n?.date || null, next_hebrew_date: n?.hebrew.en || null };
        }),
      };
      if (can(user, 'finance.read')) {
        out.recent_donations = db.prepare("SELECT date, amount, method FROM payments WHERE family_id = ? AND kind = 'donation' ORDER BY date DESC LIMIT 5")
          .all(f.id).map((p) => ({ date: p.date, amount: formatMoney(p.amount), method: p.method }));
        out.open_pledges = openPledges(db, f.id).map((p) => ({ fund: p.fund_name, balance: formatMoney(p.balance) }));
      }
      return out;
    },
  },
  {
    name: 'upcoming_occasions',
    kind: 'read',
    permission: 'occasions.read',
    description: 'Yahrzeits, birthdays and anniversaries coming up in the next N days.',
    parameters: {
      type: 'object',
      properties: { days: N('How many days ahead (default 30)'), type: S('Optional filter', { enum: OCCASION_TYPES }) },
    },
    run(db, user, { days, type }) {
      const list = upcomingOccasions(db, { days: Math.min(366, Math.max(1, Number(days) || 30)), type: OCCASION_TYPES.includes(type) ? type : undefined });
      return list.slice(0, 30).map((o) => ({ type: o.type, name: o.name, family: o.family_name, family_id: o.family_id, date: o.next.date, hebrew_date: o.next.hebrew.en, days_away: o.daysAway }));
    },
  },
  {
    name: 'list_funds',
    kind: 'read',
    permission: 'finance.read',
    description: 'Names of the donation funds.',
    parameters: { type: 'object', properties: {} },
    run(db) {
      return db.prepare('SELECT name FROM funds WHERE active = 1 ORDER BY name').all().map((f) => f.name);
    },
  },
  {
    name: 'create_contact',
    kind: 'write',
    permission: 'contacts.write',
    description: 'Create a new contact (family). It checks for existing similar contacts itself, so no search is needed first. Include family members mentioned together (e.g. a spouse).',
    parameters: {
      type: 'object',
      properties: {
        family_name: S('Family / last name; use the person name if no surname was given'),
        first_name: S('First name of the main person'),
        salutation: S('How to address them, e.g. "Sr. e Sra. Cohen"'),
        email: S('Email address, exactly as spelled by the user'),
        mobile: S('Mobile phone'),
        phone: S('Other phone'),
        city: S('City'),
        notes: S('Notes'),
        confirmed_new: { type: 'boolean', description: 'True only after the user said to create it even though similar contacts exist' },
        members: {
          type: 'array',
          description: 'Other family members to add',
          items: {
            type: 'object',
            properties: { first_name: S('First name'), last_name: S('Last name'), relation: S('Relation', { enum: RELATIONS }) },
            required: ['first_name'],
          },
        },
      },
      required: ['family_name'],
    },
    prepare(db, user, a) {
      const v = {
        family_name: clean(a.family_name) || fail('family_name is required'),
        first_name: clean(a.first_name), salutation: clean(a.salutation), email: clean(a.email)?.toLowerCase() || null,
        mobile: clean(a.mobile), phone: clean(a.phone), city: clean(a.city), notes: clean(a.notes),
        members: (Array.isArray(a.members) ? a.members : []).map((m) => ({
          first_name: clean(m.first_name), last_name: clean(m.last_name), relation: RELATIONS.includes(m.relation) ? m.relation : 'other',
        })).filter((m) => m.first_name),
      };
      if (v.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) fail(`"${v.email}" is not a valid email address; ask the user to spell it.`);
      // Possible duplicates: same email, or a contact matching the family or first name.
      const similar = new Map();
      if (v.email) for (const f of findFamilies(db, { q: v.email }, { limit: 5 }).rows) similar.set(f.id, f);
      for (const q of [v.family_name, v.first_name].filter(Boolean)) {
        for (const f of findFamilies(db, { q }, { limit: 5 }).rows) similar.set(f.id, f);
      }
      const parts = [`Criar contato "${v.family_name}"`];
      if (v.first_name) parts.push(`titular ${v.first_name}`);
      if (v.email) parts.push(`email ${v.email}`);
      if (v.mobile) parts.push(`celular ${v.mobile}`);
      if (v.city) parts.push(`cidade ${v.city}`);
      for (const m of v.members) parts.push(`com ${m.first_name}${m.last_name ? ` ${m.last_name}` : ''} (${RELATION_PT[m.relation]})`);
      const out = { args: v, summary: parts.join(', ') };
      if (similar.size && !a.confirmed_new) {
        out.warning = {
          message: 'Similar contacts already exist. Ask the user whether one of them is the same person (then use it) or whether to create a new contact anyway (then call create_contact again with confirmed_new: true).',
          similar: [...similar.values()].slice(0, 5).map(brief),
        };
      }
      return out;
    },
    execute(db, user, v) {
      const id = db.transaction(() => {
        const fid = Number(db.prepare('INSERT INTO families (family_name, salutation, email, mobile, phone, city, notes, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(v.family_name, v.salutation, v.email, v.mobile, v.phone, v.city, v.notes, 'Buggy').lastInsertRowid);
        const person = db.prepare('INSERT INTO people (family_id, relation, first_name, last_name, email, mobile) VALUES (?, ?, ?, ?, ?, ?)');
        if (v.first_name) person.run(fid, 'primary', v.first_name, v.family_name, v.email, v.mobile);
        for (const m of v.members) person.run(fid, m.relation, m.first_name, m.last_name || v.family_name, null, null);
        return fid;
      })();
      audit(db, user, 'create', 'family', id, 'via Buggy');
      return { message: `Contato "${v.family_name}" criado.`, link: `/families/${id}`, family_id: id };
    },
  },
  {
    name: 'add_family_member',
    kind: 'write',
    permission: 'contacts.write',
    description: 'Add a person (spouse, child, parent...) to an existing contact.',
    parameters: {
      type: 'object',
      properties: {
        family_id: N('Contact id'), first_name: S('First name'), last_name: S('Last name'),
        relation: S('Relation to the family', { enum: RELATIONS }), birth_date: S('Birth date YYYY-MM-DD'),
        email: S('Email'), mobile: S('Mobile phone'), hebrew_name: S('Hebrew name'),
      },
      required: ['family_id', 'first_name', 'relation'],
    },
    prepare(db, user, a) {
      const f = family(db, a.family_id);
      const v = {
        family_id: f.id, first_name: clean(a.first_name) || fail('first_name is required'), last_name: clean(a.last_name) || f.family_name,
        relation: RELATIONS.includes(a.relation) ? a.relation : 'other', birth_date: isoDate(a.birth_date),
        email: clean(a.email), mobile: clean(a.mobile), hebrew_name: clean(a.hebrew_name),
      };
      return { args: v, summary: `Adicionar ${v.first_name} ${v.last_name} (${RELATION_PT[v.relation]}) à família ${f.family_name}${v.birth_date ? `, nascido(a) em ${v.birth_date}` : ''}` };
    },
    execute(db, user, v) {
      const id = db.prepare('INSERT INTO people (family_id, relation, first_name, last_name, birth_date, email, mobile, hebrew_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(v.family_id, v.relation, v.first_name, v.last_name, v.birth_date, v.email, v.mobile, v.hebrew_name).lastInsertRowid;
      audit(db, user, 'create', 'person', id, 'via Buggy');
      return { message: `${v.first_name} adicionado(a).`, link: `/families/${v.family_id}` };
    },
  },
  {
    name: 'update_contact_info',
    kind: 'write',
    permission: 'contacts.contact_info',
    description: 'Change the email, phones or address of an existing contact. Only pass the fields that change.',
    parameters: {
      type: 'object',
      properties: {
        family_id: N('Contact id'), email: S('New email'), mobile: S('New mobile'), phone: S('New phone'),
        street: S('Street'), number: S('Number'), complement: S('Complement'), neighborhood: S('Neighborhood'),
        city: S('City'), state: S('State, e.g. PR'), cep: S('CEP (postal code)'),
      },
      required: ['family_id'],
    },
    prepare(db, user, a) {
      const f = family(db, a.family_id);
      const fields = ['email', 'mobile', 'phone', 'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'cep'];
      const changes = {};
      for (const k of fields) if (clean(a[k])) changes[k] = k === 'cep' ? clean(a[k]).replace(/\D/g, '') : clean(a[k]);
      if (!Object.keys(changes).length) fail('Nothing to change was given.');
      return { args: { family_id: f.id, changes }, summary: `Atualizar ${f.family_name}: ${Object.entries(changes).map(([k, v]) => `${k} = ${v}`).join(', ')}` };
    },
    execute(db, user, { family_id, changes }) {
      const keys = Object.keys(changes);
      db.prepare(`UPDATE families SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => changes[k]), family_id);
      audit(db, user, 'update', 'family', family_id, { fields: keys, via: 'Buggy' });
      return { message: 'Contato atualizado.', link: `/families/${family_id}` };
    },
  },
  {
    name: 'record_donation',
    kind: 'write',
    permission: 'finance.write',
    description: 'Record a donation that was received. Omit family_id only for an anonymous donor.',
    parameters: {
      type: 'object',
      properties: {
        family_id: N('Donor contact id'), amount: N('Amount in reais, e.g. 180 or 1234.5'),
        fund: S('Fund name; default is the general fund'), method: S('How it was paid', { enum: METHODS }),
        date: S('Date received YYYY-MM-DD; default today'), notes: S('Notes, e.g. dedication'),
      },
      required: ['amount'],
    },
    prepare(db, user, a) {
      const f = a.family_id ? family(db, a.family_id) : null;
      const amount = typeof a.amount === 'number' ? Math.round(a.amount * 100) : parseMoney(a.amount);
      if (!(amount > 0)) fail('A positive amount is required.');
      const fund = findFund(db, a.fund);
      const v = { family_id: f?.id ?? null, amount, fund_id: fund.id, method: METHODS.includes(a.method) ? a.method : 'pix', date: isoDate(a.date) || todayISO(), notes: clean(a.notes) };
      return { args: v, summary: `Registrar doação de ${formatMoney(amount)} de ${f ? f.family_name : 'doador anônimo'}, fundo ${fund.name}, via ${METHOD_PT[v.method]}, em ${v.date}` };
    },
    execute(db, user, v) {
      const id = recordDonation(db, { familyId: v.family_id, date: v.date, method: v.method, notes: v.notes, userId: user.id, splits: [{ fundId: v.fund_id, amount: v.amount }] });
      audit(db, user, 'create', 'donation', id, 'via Buggy');
      return { message: `Doação de ${formatMoney(v.amount)} registrada.`, link: `/finance/donations/${id}` };
    },
  },
  {
    name: 'add_occasion',
    kind: 'write',
    permission: 'occasions.write',
    description: 'Add a Yahrzeit, birthday, anniversary or bar/bat mitzvah to a contact. Give either the civil date or the Hebrew date.',
    parameters: {
      type: 'object',
      properties: {
        family_id: N('Contact id'), type: S('Kind of occasion', { enum: OCCASION_TYPES }),
        name: S('Name of the person (the deceased for a Yahrzeit)'), hebrew_name: S('Hebrew name'), relationship: S('e.g. "father of Moshe"'),
        date: S('Civil date of the event YYYY-MM-DD'), after_sunset: { type: 'boolean', description: 'True if it happened after sunset' },
        hebrew_day: N('Hebrew day of month'), hebrew_month: S('Hebrew month', { enum: HEBREW_MONTHS }), hebrew_year: N('Hebrew year, e.g. 5786'),
      },
      required: ['family_id', 'type', 'name'],
    },
    prepare(db, user, a) {
      const f = family(db, a.family_id);
      let date = isoDate(a.date);
      let afterSunset = !!a.after_sunset;
      if (!date && a.hebrew_day && a.hebrew_month && a.hebrew_year) {
        try { date = fromHebrew(a.hebrew_day, a.hebrew_month, a.hebrew_year); } catch { fail('That Hebrew date is not valid.'); }
        afterSunset = false; // the Hebrew date is exact
      }
      if (!date) fail('A civil date (YYYY-MM-DD) or a full Hebrew date is required; ask the user.');
      const v = {
        family_id: f.id, type: OCCASION_TYPES.includes(a.type) ? a.type : 'other', name: clean(a.name) || fail('name is required'),
        hebrew_name: clean(a.hebrew_name), relationship: clean(a.relationship), gregorian_date: date, after_sunset: afterSunset ? 1 : 0,
      };
      const h = formatHebrew(toHebrew(date, afterSunset));
      const next = nextOccurrence({ ...v, observe: 'hebrew' });
      return {
        args: v,
        summary: `Adicionar ${OCCASION_LABELS[v.type]} de ${v.name} (${date} = ${h.en}) à família ${f.family_name}${next ? `. Próxima data: ${next.date} (${next.hebrew.en})` : ''}`,
      };
    },
    execute(db, user, v) {
      const id = db.prepare(`INSERT INTO occasions (family_id, type, name, hebrew_name, relationship, gregorian_date, after_sunset, remind_days_before)
        VALUES (?, ?, ?, ?, ?, ?, ?, 7)`).run(v.family_id, v.type, v.name, v.hebrew_name, v.relationship, v.gregorian_date, v.after_sunset).lastInsertRowid;
      audit(db, user, 'create', 'occasion', id, 'via Buggy');
      return { message: `${OCCASION_LABELS[v.type]} de ${v.name} adicionado(a).`, link: `/families/${v.family_id}` };
    },
  },
];

/** Tools available to a user, in Gemini's function-declaration format. */
export function toolsFor(user) {
  return TOOLS.filter((t) => can(user, t.permission));
}

export function declarations(tools) {
  return tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export function findTool(user, name) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return { error: `Unknown tool ${name}` };
  if (!can(user, t.permission)) return { error: 'The current user is not allowed to do this.' };
  return { tool: t };
}

export { ToolError, salutationOf };
