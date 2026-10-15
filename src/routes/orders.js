// Judaica & holiday orders: Shmura Matzah, Arba Minim, Tefillin, etc.
import express from 'express';
import { can, requirePermission } from '../lib/permissions.js';
import { orderTotal, amountPaid } from '../lib/finance.js';
import { createCheckout, onlinePaymentsEnabled } from '../lib/stripe.js';
import { deliver } from '../lib/messaging.js';
import { parseMoney, textToHtml, formatMoney, salutationOf } from '../lib/format.js';
import { todayISO } from '../lib/hebrew.js';
import { audit } from '../lib/audit.js';
import { str, bool, int, date, oneOf, mustGet, httpError, toCsv } from '../lib/forms.js';

const router = express.Router();
const CATEGORIES = ['matzah', 'arba_minim', 'tefillin', 'mezuzah', 'candles', 'other'];
const STATUSES = ['open', 'ready', 'delivered', 'cancelled'];
const METHODS = ['cash', 'check', 'pix', 'card', 'transfer', 'online', 'other'];

router.use(requirePermission('orders.read'));

router.get('/', (req, res) => {
  const db = req.app.get('db');
  const where = [];
  const params = [];
  if (STATUSES.includes(req.query.status)) { where.push('o.status = ?'); params.push(req.query.status); }
  if (str(req.query.season)) { where.push('EXISTS (SELECT 1 FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = o.id AND p.season = ?)'); params.push(req.query.season); }
  const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orders = db.prepare(`SELECT o.*, f.family_name FROM orders o JOIN families f ON f.id = o.family_id ${sqlWhere} ORDER BY o.date DESC, o.id DESC`).all(...params)
    .map((o) => ({ ...o, total: orderTotal(db, o.id), paid: amountPaid(db, 'order', o.id) }));
  // Quantities to procure, per product, for the filtered orders (excluding cancelled).
  const summary = db.prepare(`SELECT p.name, p.season, SUM(i.quantity) qty, SUM(i.quantity * i.unit_price) total
    FROM order_items i JOIN products p ON p.id = i.product_id JOIN orders o ON o.id = i.order_id
    ${sqlWhere ? `${sqlWhere} AND` : 'WHERE'} o.status <> 'cancelled' GROUP BY p.id ORDER BY p.name`).all(...params);
  const seasons = db.prepare("SELECT DISTINCT season FROM products WHERE COALESCE(season,'') <> '' ORDER BY season DESC").all().map((r) => r.season);
  if (req.query.format === 'csv') {
    return res.type('text/csv').attachment('orders.csv').send(toCsv(orders, [
      { label: 'Order', key: 'id' }, { label: 'Date', key: 'date' }, { label: 'Family', key: 'family_name' }, { label: 'Status', key: 'status' },
      { label: 'Items', value: (o) => db.prepare('SELECT p.name, i.quantity FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ?').all(o.id).map((i) => `${i.quantity}× ${i.name}`).join('; ') },
      { label: 'Total', value: (o) => (o.total / 100).toFixed(2) }, { label: 'Paid', value: (o) => (o.paid / 100).toFixed(2) },
    ]));
  }
  res.render('orders/index', { title: 'Holiday & Judaica orders', orders, summary, seasons, q: req.query, statuses: STATUSES });
});

router.get('/products', (req, res) => {
  const db = req.app.get('db');
  res.render('orders/products', { title: 'Products', products: db.prepare('SELECT * FROM products ORDER BY active DESC, category, name').all(), categories: CATEGORIES });
});

router.post('/products', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const name = str(req.body.name);
  if (!name) throw httpError(400, 'Name is required');
  db.prepare('INSERT INTO products (name, category, season, price) VALUES (?, ?, ?, ?)').run(
    name, oneOf(req.body.category, CATEGORIES, 'other'), str(req.body.season), parseMoney(req.body.price),
  );
  req.flash('success', `Product "${name}" added.`);
  res.redirect('/orders/products');
});

router.post('/products/:id', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const p = mustGet(db, 'products', req.params.id);
  db.prepare('UPDATE products SET name = ?, category = ?, season = ?, price = ?, active = ? WHERE id = ?').run(
    str(req.body.name) || p.name, oneOf(req.body.category, CATEGORIES, p.category), str(req.body.season), parseMoney(req.body.price), bool(req.body.active), p.id,
  );
  req.flash('success', 'Product saved.');
  res.redirect('/orders/products');
});

router.get('/new', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.query.family_id);
  res.render('orders/form', { title: 'New order', family, products: db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY category, name').all(), today: todayISO() });
});

router.post('/', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const family = mustGet(db, 'families', req.body.family_id);
  const qty = req.body.qty || {};
  // Keys are "p<productId>" so the body parser keeps them as an object, not a compacted array.
  const items = Object.entries(qty).map(([key, q]) => ({ product: db.prepare('SELECT * FROM products WHERE id = ?').get(Number(String(key).replace(/^p/, ''))), q: int(q, 0) }))
    .filter((i) => i.product && i.q > 0);
  if (!items.length) throw httpError(400, 'Add at least one item');
  const id = db.transaction(() => {
    const { lastInsertRowid } = db.prepare('INSERT INTO orders (family_id, date, notes) VALUES (?, ?, ?)').run(family.id, date(req.body.date) || todayISO(), str(req.body.notes));
    const ins = db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, ?, ?, ?)');
    for (const i of items) ins.run(lastInsertRowid, i.product.id, i.q, i.product.price);
    return lastInsertRowid;
  })();
  audit(db, req.user, 'create', 'order', id);
  req.flash('success', 'Order created.');
  res.redirect(`/orders/${id}`);
});

router.get('/:id', (req, res) => {
  const db = req.app.get('db');
  const order = mustGet(db, 'orders', req.params.id);
  const family = mustGet(db, 'families', order.family_id);
  const items = db.prepare('SELECT i.*, p.name, p.season FROM order_items i JOIN products p ON p.id = i.product_id WHERE i.order_id = ?').all(order.id);
  const payments = can(req.user, 'finance.read') || can(req.user, 'orders.write')
    ? db.prepare("SELECT * FROM payments WHERE kind = 'order' AND ref_id = ? ORDER BY date").all(order.id) : [];
  const total = orderTotal(db, order.id);
  const paid = amountPaid(db, 'order', order.id);
  res.render('orders/show', { title: `Order #${order.id}`, order, family, items, payments, total, paid, statuses: STATUSES, methods: METHODS, today: todayISO(), online: onlinePaymentsEnabled() });
});

router.post('/:id/status', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const order = mustGet(db, 'orders', req.params.id);
  db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(oneOf(req.body.status, STATUSES, order.status), order.id);
  audit(db, req.user, 'status', 'order', order.id, req.body.status);
  res.redirect(`/orders/${order.id}`);
});

router.post('/:id/payments', requirePermission('orders.write'), (req, res) => {
  const db = req.app.get('db');
  const order = mustGet(db, 'orders', req.params.id);
  const amount = parseMoney(req.body.amount);
  if (amount <= 0) throw httpError(400, 'Amount is required');
  db.prepare("INSERT INTO payments (family_id, kind, ref_id, date, amount, method, reference, created_by) VALUES (?, 'order', ?, ?, ?, ?, ?, ?)").run(
    order.family_id, order.id, date(req.body.date) || todayISO(), amount, oneOf(req.body.method, METHODS, 'cash'), str(req.body.reference), req.user.id,
  );
  audit(db, req.user, 'payment', 'order', order.id, amount);
  req.flash('success', 'Payment recorded.');
  res.redirect(`/orders/${order.id}`);
});

// Email the family a secure Stripe Checkout link for the balance.
router.post('/:id/pay-link', requirePermission('orders.write'), async (req, res) => {
  const db = req.app.get('db');
  if (!onlinePaymentsEnabled()) throw httpError(400, 'Online payments are not configured');
  const order = mustGet(db, 'orders', req.params.id);
  const family = mustGet(db, 'families', order.family_id);
  const balance = orderTotal(db, order.id) - amountPaid(db, 'order', order.id);
  if (balance <= 0) throw httpError(400, 'Nothing is owed on this order');
  const url = await createCheckout({
    amount: balance, description: `Order #${order.id}`, email: family.email,
    metadata: { kind: 'order', ref_id: order.id, family_id: family.id }, successPath: '/thank-you', cancelPath: '/',
  });
  const settings = res.locals.settings;
  const body = `Dear ${salutationOf(family)},\n\nYour order #${order.id} has a balance of ${formatMoney(balance)}. You can pay securely online here:\n${url}\n\n${settings.org_name}`;
  if (family.email) await deliver(db, { channel: 'email', to: family.email, familyId: family.id, subject: `Payment for order #${order.id}`, text: body, html: textToHtml(body) });
  req.flash('success', family.email ? `Payment link emailed to ${family.email}.` : `No email on file. Share this link: ${url}`);
  res.redirect(`/orders/${order.id}`);
});

export default router;
