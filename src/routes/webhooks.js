// Stripe webhook: records online donations / registration / order payments.
import express from 'express';
import { verifyWebhook, onlinePaymentsEnabled } from '../lib/stripe.js';
import { recordDonation } from '../lib/finance.js';
import { todayISO } from '../lib/hebrew.js';
import { familyIdByEmail } from './public.js';

const router = express.Router();

/** Applies a completed Checkout session. Idempotent on session id. */
export function applyCheckoutSession(db, session) {
  if (session.payment_status !== 'paid') return 'unpaid';
  if (db.prepare('SELECT 1 FROM payments WHERE stripe_session_id = ?').get(session.id)) return 'duplicate';
  const m = session.metadata || {};
  const amount = session.amount_total;
  const email = session.customer_details?.email || session.customer_email;
  const reference = typeof session.payment_intent === 'string' ? session.payment_intent : session.id;

  if (m.kind === 'donation') {
    const familyId = familyIdByEmail(db, email);
    recordDonation(db, {
      familyId, date: todayISO(), method: 'online', reference, stripeSessionId: session.id,
      splits: [{ fundId: Number(m.fund_id), amount }],
      notes: [familyId ? null : `Online donor: ${m.name || ''} <${email || ''}>`, m.dedication ? `Dedication: ${m.dedication}` : null].filter(Boolean).join('\n') || null,
    });
    return 'donation';
  }
  if (m.kind === 'registration' || m.kind === 'order') {
    const table = m.kind === 'registration' ? 'registrations' : 'orders';
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(m.ref_id));
    if (!row) return 'missing';
    db.prepare("INSERT INTO payments (family_id, kind, ref_id, date, amount, method, reference, stripe_session_id) VALUES (?, ?, ?, ?, ?, 'online', ?, ?)").run(
      row.family_id ?? null, m.kind, row.id, todayISO(), amount, reference, session.id,
    );
    if (m.kind === 'registration') db.prepare("UPDATE registrations SET status = 'paid' WHERE id = ?").run(row.id);
    return m.kind;
  }
  return 'ignored';
}

router.post('/stripe', (req, res) => {
  if (!onlinePaymentsEnabled()) return res.status(404).end();
  let event;
  try {
    event = verifyWebhook(req.body, req.get('stripe-signature'));
  } catch (e) {
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    applyCheckoutSession(req.app.get('db'), event.data.object);
  }
  res.json({ received: true });
});

export default router;
