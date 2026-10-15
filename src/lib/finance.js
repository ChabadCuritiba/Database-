// Donation, pledge and billing logic shared by staff screens, public pages and webhooks.
import { nextReceiptNumber } from '../db/index.js';
import { formatMoney, salutationOf, merge } from './format.js';
import { formatGregorian } from './hebrew.js';
import { config } from '../config.js';

/**
 * Records a donation and its fund splits atomically.
 * splits: [{ fundId, amount }] (cents). If omitted, the whole amount goes to the General fund.
 */
export function recordDonation(db, { familyId, date, splits, method = 'cash', reference, pledgeId, notes, userId, stripeSessionId, issueReceipt = true }) {
  return db.transaction(() => {
    let parts = (splits || []).filter((s) => s.amount > 0 && s.fundId);
    if (!parts.length) throw new Error('A donation needs at least one fund amount');
    const amount = parts.reduce((t, s) => t + s.amount, 0);
    if (pledgeId) {
      const pledge = db.prepare('SELECT * FROM pledges WHERE id = ?').get(pledgeId);
      if (!pledge || pledge.family_id !== familyId) throw new Error('Pledge does not belong to this family');
    }
    const receipt = issueReceipt ? nextReceiptNumber(db) : null;
    const { lastInsertRowid: id } = db
      .prepare(`INSERT INTO payments (family_id, kind, pledge_id, date, amount, method, reference, receipt_number, notes, created_by, stripe_session_id)
                VALUES (?, 'donation', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(familyId ?? null, pledgeId || null, date, amount, method, reference || null, receipt, notes || null, userId ?? null, stripeSessionId || null);
    const ins = db.prepare('INSERT INTO payment_splits (payment_id, fund_id, amount) VALUES (?, ?, ?)');
    for (const s of parts) ins.run(id, s.fundId, s.amount);
    if (pledgeId) refreshPledgeStatus(db, pledgeId);
    return Number(id);
  })();
}

export function generalFundId(db) {
  return (db.prepare("SELECT id FROM funds WHERE name IN ('Geral', 'General')").get() || db.prepare('SELECT id FROM funds ORDER BY id LIMIT 1').get()).id;
}

export function pledgeBalance(db, pledgeId) {
  const p = db.prepare('SELECT amount FROM pledges WHERE id = ?').get(pledgeId);
  const paid = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payments WHERE pledge_id = ? AND kind = 'donation'").get(pledgeId).s;
  return { amount: p?.amount || 0, paid, balance: Math.max(0, (p?.amount || 0) - paid) };
}

export function refreshPledgeStatus(db, pledgeId) {
  const p = db.prepare('SELECT status FROM pledges WHERE id = ?').get(pledgeId);
  if (!p || p.status === 'cancelled') return;
  const { balance } = pledgeBalance(db, pledgeId);
  db.prepare('UPDATE pledges SET status = ? WHERE id = ?').run(balance === 0 ? 'fulfilled' : 'open', pledgeId);
}

export function openPledges(db, familyId) {
  const rows = familyId
    ? db.prepare("SELECT p.*, f.name fund_name FROM pledges p JOIN funds f ON f.id = p.fund_id WHERE p.family_id = ? AND p.status = 'open' ORDER BY p.date").all(familyId)
    : db.prepare(`SELECT p.*, f.name fund_name, fam.family_name FROM pledges p JOIN funds f ON f.id = p.fund_id
                  JOIN families fam ON fam.id = p.family_id WHERE p.status = 'open' ORDER BY p.due_date IS NULL, p.due_date, p.date`).all();
  return rows.map((p) => ({ ...p, ...pledgeBalance(db, p.id) }));
}

export function splitsFor(db, paymentId) {
  return db.prepare('SELECT s.*, f.name fund_name FROM payment_splits s JOIN funds f ON f.id = s.fund_id WHERE s.payment_id = ?').all(paymentId);
}

/** Data for printing receipts for the given payment ids. Assigns receipt numbers if missing. */
export function receiptData(db, paymentIds) {
  return paymentIds
    .map((id) => {
      let payment = db.prepare("SELECT * FROM payments WHERE id = ? AND kind = 'donation'").get(id);
      if (!payment) return null;
      if (!payment.receipt_number) {
        db.prepare('UPDATE payments SET receipt_number = ? WHERE id = ?').run(nextReceiptNumber(db), id);
        payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
      }
      const family = payment.family_id ? db.prepare('SELECT * FROM families WHERE id = ?').get(payment.family_id) : null;
      return { payment, family, splits: splitsFor(db, id) };
    })
    .filter(Boolean);
}

/** Per-family donation statements for a calendar year (tax-deductible funds only). */
export function yearEndStatements(db, year, familyIds) {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;
  const ids = familyIds?.length
    ? familyIds
    : db.prepare("SELECT DISTINCT family_id id FROM payments WHERE kind = 'donation' AND family_id IS NOT NULL AND date BETWEEN ? AND ?").all(from, to).map((r) => r.id);
  const pay = db.prepare(`
    SELECT p.id, p.date, p.receipt_number, SUM(s.amount) amount, GROUP_CONCAT(f.name, ', ') funds
    FROM payments p JOIN payment_splits s ON s.payment_id = p.id JOIN funds f ON f.id = s.fund_id
    WHERE p.family_id = ? AND p.kind = 'donation' AND f.tax_deductible = 1 AND p.date BETWEEN ? AND ?
    GROUP BY p.id ORDER BY p.date`);
  return ids
    .map((id) => ({ family: db.prepare('SELECT * FROM families WHERE id = ?').get(id), payments: pay.all(id, from, to) }))
    .filter((s) => s.family && s.payments.length)
    .sort((a, b) => a.family.family_name.localeCompare(b.family.family_name));
}

export function thankYouLetters(db, settings, paymentIds) {
  return receiptData(db, paymentIds)
    .filter((r) => r.family)
    .map((r) => ({
      family: r.family,
      paymentId: r.payment.id,
      body: merge(settings.thank_you_body, {
        salutation: salutationOf(r.family),
        family_name: r.family.family_name,
        amount: formatMoney(r.payment.amount),
        date: formatGregorian(r.payment.date, config.locale),
        fund: r.splits.map((s) => s.fund_name).join(', '),
        receipt_number: r.payment.receipt_number,
        org_name: settings.org_name,
      }),
    }));
}

export function orderTotal(db, orderId) {
  return db.prepare('SELECT COALESCE(SUM(quantity * unit_price),0) t FROM order_items WHERE order_id = ?').get(orderId).t;
}

export function amountPaid(db, kind, refId) {
  return db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE kind = ? AND ref_id = ?').get(kind, refId).s;
}

export function registrationTotal(event, { adults = 0, students = 0, children = 0 }) {
  return adults * event.price_adult + students * event.price_student + children * event.price_child;
}
