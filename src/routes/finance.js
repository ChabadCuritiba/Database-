import express from 'express';
import { requirePermission } from '../lib/permissions.js';
import {
  recordDonation, openPledges, splitsFor, receiptData, yearEndStatements, thankYouLetters, refreshPledgeStatus,
} from '../lib/finance.js';
import { receiptsPdf, yearEndStatementsPdf, lettersPdf } from '../lib/pdf.js';
import { lettersDocx } from '../lib/word.js';
import { deliver } from '../lib/messaging.js';
import { getSettings } from '../db/index.js';
import { parseMoney, textToHtml, salutationOf } from '../lib/format.js';
import { todayISO } from '../lib/hebrew.js';
import { audit } from '../lib/audit.js';
import { str, bool, int, date, ids, oneOf, mustGet, httpError, toCsv } from '../lib/forms.js';

const router = express.Router();
const METHODS = ['cash', 'check', 'pix', 'card', 'transfer', 'online', 'other'];
const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

router.use(requirePermission('finance.read'));

const funds = (db, all = false) => db.prepare(`SELECT * FROM funds ${all ? '' : 'WHERE active = 1'} ORDER BY name`).all();

router.get('/', (req, res) => {
  const db = req.app.get('db');
  const year = int(req.query.year, new Date().getFullYear());
  const byFund = db.prepare(`
    SELECT f.name, SUM(s.amount) total, COUNT(DISTINCT p.id) n FROM payment_splits s
    JOIN payments p ON p.id = s.payment_id JOIN funds f ON f.id = s.fund_id
    WHERE p.date BETWEEN ? AND ? GROUP BY f.id ORDER BY total DESC`).all(`${year}-01-01`, `${year}-12-31`);
  const byMonth = db.prepare(`SELECT substr(date,6,2) m, SUM(amount) total FROM payments WHERE kind = 'donation' AND date BETWEEN ? AND ? GROUP BY 1`).all(`${year}-01-01`, `${year}-12-31`);
  const byKind = db.prepare('SELECT kind, SUM(amount) total FROM payments WHERE date BETWEEN ? AND ? GROUP BY kind').all(`${year}-01-01`, `${year}-12-31`);
  const recent = db.prepare(`SELECT p.*, f.family_name FROM payments p LEFT JOIN families f ON f.id = p.family_id ORDER BY p.date DESC, p.id DESC LIMIT 15`).all();
  const unthanked = db.prepare("SELECT COUNT(*) n FROM payments WHERE kind = 'donation' AND thanked_at IS NULL AND family_id IS NOT NULL").get().n;
  res.render('finance/index', { title: 'Finance', year, byFund, byMonth, byKind, recent, pledges: openPledges(db).slice(0, 15), unthanked });
});

function paymentFilter(q) {
  const where = [];
  const params = [];
  if (date(q.from)) { where.push('p.date >= ?'); params.push(q.from); }
  if (date(q.to)) { where.push('p.date <= ?'); params.push(q.to); }
  if (['donation', 'order', 'registration'].includes(q.kind)) { where.push('p.kind = ?'); params.push(q.kind); }
  if (int(q.fund_id)) { where.push('EXISTS (SELECT 1 FROM payment_splits s WHERE s.payment_id = p.id AND s.fund_id = ?)'); params.push(int(q.fund_id)); }
  if (METHODS.includes(q.method)) { where.push('p.method = ?'); params.push(q.method); }
  if (q.unthanked === '1') where.push("p.thanked_at IS NULL AND p.kind = 'donation'");
  if (str(q.q)) { where.push('(fam.family_name LIKE ? OR p.reference LIKE ? OR CAST(p.receipt_number AS TEXT) = ?)'); params.push(`%${q.q}%`, `%${q.q}%`, q.q); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

router.get('/payments', (req, res) => {
  const db = req.app.get('db');
  const f = paymentFilter(req.query);
  const rows = db.prepare(`SELECT p.*, fam.family_name FROM payments p LEFT JOIN families fam ON fam.id = p.family_id ${f.sql} ORDER BY p.date DESC, p.id DESC LIMIT 1000`).all(...f.params)
    .map((p) => ({ ...p, splits: p.kind === 'donation' ? splitsFor(db, p.id) : [] }));
  const total = rows.reduce((t, r) => t + r.amount, 0);
  if (req.query.format === 'csv') {
    audit(db, req.user, 'export', 'payments', null, { count: rows.length });
    return res.type('text/csv').attachment('payments.csv').send(toCsv(rows, [
      { label: 'ID', key: 'id' }, { label: 'Date', key: 'date' }, { label: 'Receipt', key: 'receipt_number' },
      { label: 'Family', key: 'family_name' }, { label: 'Kind', key: 'kind' }, { label: 'Method', key: 'method' },
      { label: 'Reference', key: 'reference' }, { label: 'Amount', value: (r) => (r.amount / 100).toFixed(2) },
      { label: 'Funds', value: (r) => r.splits.map((s) => `${s.fund_name}: ${(s.amount / 100).toFixed(2)}`).join('; ') },
    ]));
  }
  res.render('finance/payments', { title: 'Payments', rows, total, q: req.query, funds: funds(db, true), methods: METHODS });
});

router.get('/donations/new', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const family = int(req.query.family_id) ? mustGet(db, 'families', req.query.family_id) : null;
  res.render('finance/donation-form', {
    title: 'Record donation', family, funds: funds(db), methods: METHODS, today: todayISO(),
    pledges: family ? openPledges(db, family.id) : [], pledgeId: int(req.query.pledge_id),
  });
});

router.post('/donations', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const familyId = int(req.body.family_id);
  if (familyId) mustGet(db, 'families', familyId);
  const rawSplits = Array.isArray(req.body.splits) ? req.body.splits : Object.values(req.body.splits || {});
  const splits = rawSplits.map((s) => ({ fundId: int(s.fund_id), amount: parseMoney(s.amount) })).filter((s) => s.fundId && s.amount > 0);
  const id = recordDonation(db, {
    familyId, splits,
    date: date(req.body.date) || todayISO(),
    method: oneOf(req.body.method, METHODS, 'cash'),
    reference: str(req.body.reference),
    pledgeId: int(req.body.pledge_id),
    notes: str(req.body.notes),
    userId: req.user.id,
  });
  audit(db, req.user, 'create', 'donation', id);
  req.flash('success', 'Donation recorded.');
  res.redirect(bool(req.body.another) ? `/finance/donations/new${familyId ? `?family_id=${familyId}` : ''}` : `/finance/donations/${id}`);
});

router.get('/donations/:id', (req, res) => {
  const db = req.app.get('db');
  const payment = mustGet(db, 'payments', req.params.id);
  const family = payment.family_id ? db.prepare('SELECT * FROM families WHERE id = ?').get(payment.family_id) : null;
  res.render('finance/donation', { title: `Payment #${payment.id}`, payment, family, splits: splitsFor(db, payment.id) });
});

router.post('/donations/:id/delete', requirePermission('admin'), (req, res) => {
  const db = req.app.get('db');
  const payment = mustGet(db, 'payments', req.params.id);
  db.prepare('DELETE FROM payments WHERE id = ?').run(payment.id);
  if (payment.pledge_id) refreshPledgeStatus(db, payment.pledge_id);
  audit(db, req.user, 'delete', 'payment', payment.id, { amount: payment.amount, family_id: payment.family_id, receipt: payment.receipt_number });
  req.flash('success', 'Payment deleted.');
  res.redirect(payment.family_id ? `/families/${payment.family_id}` : '/finance/payments');
});

router.get('/donations/:id/receipt.pdf', async (req, res) => {
  const db = req.app.get('db');
  const data = receiptData(db, [Number(req.params.id)]);
  if (!data.length) throw httpError(404, 'Donation not found');
  res.type(PDF).attachment(`recibo-${data[0].payment.receipt_number}.pdf`).send(await receiptsPdf(getSettings(db), data));
});

// Batch receipts for selected payments or a date range.
router.post('/receipts', async (req, res) => {
  const db = req.app.get('db');
  let selected = ids(req.body.ids);
  if (!selected.length && date(req.body.from) && date(req.body.to)) {
    selected = db.prepare("SELECT id FROM payments WHERE kind = 'donation' AND date BETWEEN ? AND ? ORDER BY date").all(req.body.from, req.body.to).map((r) => r.id);
  }
  const data = receiptData(db, selected);
  if (!data.length) throw httpError(400, 'No donations selected');
  audit(db, req.user, 'print', 'receipts', null, { count: data.length });
  res.type(PDF).attachment('recibos.pdf').send(await receiptsPdf(getSettings(db), data));
});

// Thank-you letters: print (PDF/Word) or email, then mark as thanked.
router.post('/thank-you', async (req, res) => {
  const db = req.app.get('db');
  const settings = getSettings(db);
  let selected = ids(req.body.ids);
  if (!selected.length && req.body.all_unthanked === '1') {
    selected = db.prepare("SELECT id FROM payments WHERE kind = 'donation' AND thanked_at IS NULL AND family_id IS NOT NULL").all().map((r) => r.id);
  }
  const letters = thankYouLetters(db, settings, selected);
  if (!letters.length) throw httpError(400, 'No donations from known donors selected');
  const mark = db.prepare("UPDATE payments SET thanked_at = datetime('now') WHERE id = ?");
  const format = oneOf(req.body.format, ['pdf', 'docx', 'email'], 'pdf');
  audit(db, req.user, 'thank', 'payments', null, { count: letters.length, format });

  if (format === 'email') {
    let sent = 0;
    let skipped = 0;
    for (const l of letters) {
      if (!l.family.email || l.family.no_email) { skipped++; continue; }
      const receipt = await receiptsPdf(settings, receiptData(db, [l.paymentId]));
      const r = await deliver(db, {
        channel: 'email', to: l.family.email, familyId: l.family.id, subject: `Obrigado – ${settings.org_name}`,
        text: l.body, html: textToHtml(l.body), attachments: [{ filename: 'recibo.pdf', content: receipt }],
      });
      if (r.status !== 'failed') { mark.run(l.paymentId); sent++; }
    }
    req.flash('success', `Emailed ${sent} thank-you letters with receipts${skipped ? `; ${skipped} donors have no email and were skipped` : ''}.`);
    return res.redirect('/finance/payments?unthanked=1');
  }
  if (bool(req.body.mark_thanked)) db.transaction(() => letters.forEach((l) => mark.run(l.paymentId)))();
  if (format === 'docx') return res.type(DOCX).attachment('cartas-de-agradecimento.docx').send(await lettersDocx(settings, letters));
  res.type(PDF).attachment('cartas-de-agradecimento.pdf').send(await lettersPdf(settings, letters));
});

router.get('/year-end', (req, res) => {
  const db = req.app.get('db');
  const year = int(req.query.year, new Date().getFullYear() - 1);
  const statements = yearEndStatements(db, year);
  res.render('finance/year-end', { title: `Year-end statements ${year}`, year, statements });
});

router.post('/year-end', async (req, res) => {
  const db = req.app.get('db');
  const settings = getSettings(db);
  const year = int(req.body.year, new Date().getFullYear() - 1);
  const statements = yearEndStatements(db, year, ids(req.body.family_ids));
  if (!statements.length) throw httpError(400, 'No donations found for that year');
  audit(db, req.user, 'print', 'year_end', null, { year, count: statements.length });
  if (req.body.format === 'email') {
    let sent = 0;
    for (const s of statements) {
      if (!s.family.email || s.family.no_email) continue;
      const pdf = await yearEndStatementsPdf(settings, [s], year);
      const body = `Prezado(a) ${salutationOf(s.family)},\n\nSegue em anexo a sua declaração de doações de ${year}. Muito obrigado pelo seu apoio.\n\n${settings.org_name}`;
      const r = await deliver(db, { channel: 'email', to: s.family.email, familyId: s.family.id, subject: `${settings.org_name} – Declaração de doações ${year}`, text: body, html: textToHtml(body), attachments: [{ filename: `declaracao-doacoes-${year}.pdf`, content: pdf }] });
      if (r.status !== 'failed') sent++;
    }
    req.flash('success', `Emailed ${sent} statements.`);
    return res.redirect(`/finance/year-end?year=${year}`);
  }
  res.type(PDF).attachment(`declaracoes-${year}.pdf`).send(await yearEndStatementsPdf(settings, statements, year));
});

// --- Pledges ---
router.get('/pledges', (req, res) => {
  const db = req.app.get('db');
  res.render('finance/pledges', { title: 'Open pledges', pledges: openPledges(db) });
});

router.get('/pledges/new', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.query.family_id);
  res.render('finance/pledge-form', { title: 'New pledge', family, funds: funds(db), today: todayISO() });
});

router.post('/pledges', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.body.family_id);
  const amount = parseMoney(req.body.amount);
  const fundId = int(req.body.fund_id);
  if (amount <= 0 || !fundId) throw httpError(400, 'Amount and fund are required');
  const { lastInsertRowid } = db.prepare('INSERT INTO pledges (family_id, fund_id, amount, date, due_date, notes) VALUES (?, ?, ?, ?, ?, ?)').run(
    family.id, fundId, amount, date(req.body.date) || todayISO(), date(req.body.due_date), str(req.body.notes),
  );
  audit(db, req.user, 'create', 'pledge', lastInsertRowid);
  req.flash('success', 'Pledge recorded.');
  res.redirect(`/families/${family.id}`);
});

router.post('/pledges/:id/cancel', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const pledge = mustGet(db, 'pledges', req.params.id);
  db.prepare("UPDATE pledges SET status = 'cancelled' WHERE id = ?").run(pledge.id);
  audit(db, req.user, 'cancel', 'pledge', pledge.id);
  req.flash('success', 'Pledge cancelled.');
  res.redirect(`/families/${pledge.family_id}`);
});

// --- Funds (income categories) ---
router.get('/funds', (req, res) => {
  const db = req.app.get('db');
  const totals = Object.fromEntries(db.prepare('SELECT fund_id, SUM(amount) t FROM payment_splits GROUP BY fund_id').all().map((r) => [r.fund_id, r.t]));
  res.render('finance/funds', { title: 'Funds', funds: funds(db, true), totals });
});

router.post('/funds', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const name = str(req.body.name);
  if (!name) throw httpError(400, 'Name is required');
  db.prepare('INSERT INTO funds (name, tax_deductible) VALUES (?, ?)').run(name, bool(req.body.tax_deductible));
  req.flash('success', `Fund "${name}" created.`);
  res.redirect('/finance/funds');
});

router.post('/funds/:id', requirePermission('finance.write'), (req, res) => {
  const db = req.app.get('db');
  const fund = mustGet(db, 'funds', req.params.id);
  db.prepare('UPDATE funds SET name = ?, tax_deductible = ?, active = ? WHERE id = ?').run(
    str(req.body.name) || fund.name, bool(req.body.tax_deductible), bool(req.body.active), fund.id,
  );
  req.flash('success', 'Fund saved.');
  res.redirect('/finance/funds');
});

export default router;
