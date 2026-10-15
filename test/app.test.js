import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup, login, createFamily, outbox, binary } from './helpers.js';
import { recordDonation } from '../src/lib/finance.js';
import { sendDueReminders } from '../src/lib/occasions.js';
import { applyCheckoutSession } from '../src/routes/webhooks.js';
import { findAdmissible } from './util-auth.js';
import { todayISO, addDays } from '../src/lib/hebrew.js';

test('anonymous users are sent to the login page', async () => {
  const { app } = setup();
  const res = await request(app).get('/families');
  assert.equal(res.status, 302);
  assert.equal(res.headers.location, '/login');
});

test('every main page renders for an admin', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  db.prepare("INSERT INTO occasions (family_id, type, name, gregorian_date) VALUES (?, 'yahrzeit', 'Avraham', '2010-05-01')").run(fid);
  db.prepare("INSERT INTO events (slug, name, starts_at) VALUES ('shabbat', 'Shabbat dinner', '2099-01-01T19:00')").run();
  db.prepare("INSERT INTO products (name, category, price) VALUES ('Shmura Matzah', 'matzah', 9000)").run();
  const pid = recordDonation(db, { familyId: fid, date: todayISO(), splits: [{ fundId: 1, amount: 18000 }] });
  db.prepare('INSERT INTO orders (family_id, date) VALUES (?, ?)').run(fid, todayISO());
  const agent = await login(app, 'admin');
  const pages = [
    '/', `/families`, `/families/${fid}`, `/families/${fid}/edit`, '/families/new', `/families/${fid}/people/new`,
    '/categories', '/occasions', '/occasions/convert?gdate=2026-01-01', '/occasions/convert?hday=1&hmonth=Tishrei&hyear=5787',
    '/occasions/yahrzeit-letters', `/occasions/new?family_id=${fid}`,
    '/finance', '/finance/payments', `/finance/donations/new?family_id=${fid}`, '/finance/donations/new', `/finance/donations/${pid}`,
    '/finance/year-end', '/finance/pledges', `/finance/pledges/new?family_id=${fid}`, '/finance/funds',
    '/orders', '/orders/products', `/orders/new?family_id=${fid}`, '/orders/1',
    '/events', '/events?past=1', '/events/new', '/events/1', '/events/1/edit',
    '/comms', '/comms/compose?channel=email', '/comms/compose?channel=sms', '/comms/compose?channel=call', '/comms/print',
    '/admin/users', '/admin/settings', '/admin/backups', '/admin/audit', '/e/shabbat',
  ];
  for (const p of pages) {
    const res = await agent.get(p);
    assert.equal(res.status, 200, `${p} -> ${res.status} ${res.text.slice(0, 300)}`);
  }
});

test('contacts: create family with primary person, edit, categorize, search', async () => {
  const { db, app } = setup();
  const agent = await login(app, 'staff');
  let res = await agent.postForm('/families', { family_name: 'Levy', first_name: 'David', email: 'levy@example.org', priority: '1', cep: '80.020-000' });
  assert.equal(res.status, 302);
  const fam = db.prepare("SELECT * FROM families WHERE family_name = 'Levy'").get();
  assert.equal(fam.cep, '80020000');
  assert.equal(fam.priority, 1);
  assert.equal(db.prepare('SELECT first_name FROM people WHERE family_id = ?').get(fam.id).first_name, 'David');

  const parent = db.prepare("INSERT INTO categories (name) VALUES ('Mailings')").run().lastInsertRowid;
  const child = db.prepare("INSERT INTO categories (name, parent_id) VALUES ('Pesach', ?)").run(parent).lastInsertRowid;
  await agent.postForm(`/families/${fam.id}/categories`, { categories: [String(child)] });
  // Filtering by the parent category includes sub-categories.
  res = await agent.get(`/families?categories=${parent}`);
  assert.match(res.text, /Levy/);
  res = await agent.get('/families?categories=9999');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Levy/);
  res = await agent.get('/families?q=David');
  assert.match(res.text, /Levy/);
  res = await agent.get('/search?q=Levy');
  assert.equal(res.headers.location, `/families/${fam.id}`);

  await agent.postForm(`/families/${fam.id}/people`, { first_name: 'Sarah', relation: 'child', birth_date: '2015-04-02', track_birthday: '1' });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM occasions WHERE family_id = ? AND type = 'birthday'").get(fam.id).n, 1);
});

test('volunteers can only change contact details and cannot see finances', async () => {
  const { db, app } = setup();
  const fid = createFamily(db, { notes: 'secret', priority: 2 });
  const agent = await login(app, 'volunteer');
  let res = await agent.postForm(`/families/${fid}`, { family_name: 'Hacked', priority: '5', notes: 'changed', mobile: '41888887777', city: 'Londrina' });
  assert.equal(res.status, 302);
  const f = db.prepare('SELECT * FROM families WHERE id = ?').get(fid);
  assert.equal(f.family_name, 'Cohen');
  assert.equal(f.priority, 2);
  assert.equal(f.notes, 'secret');
  assert.equal(f.mobile, '41888887777');
  assert.equal(f.city, 'Londrina');

  for (const p of ['/finance', '/finance/payments', '/comms', '/admin/users', '/families/new', `/finance/donations/new?family_id=${fid}`]) {
    res = await agent.get(p);
    assert.equal(res.status, 403, p);
  }
  res = await agent.postForm('/families', { family_name: 'X' });
  assert.equal(res.status, 403);
  res = await agent.get(`/families/${fid}`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /Giving/);
});

test('staff cannot access financial records', async () => {
  const { app } = setup();
  const agent = await login(app, 'staff');
  assert.equal((await agent.get('/finance')).status, 403);
  assert.equal((await agent.get('/comms')).status, 200);
  assert.equal((await agent.get('/admin/users')).status, 403);
});

test('POST without a CSRF token is rejected', async () => {
  const { app } = setup();
  const agent = await login(app, 'admin');
  const res = await agent.post('/families').type('form').send({ family_name: 'NoToken' });
  assert.equal(res.status, 403);
});

test('donations: split across funds, receipt numbers, pledges, receipts and thank-yous', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  const agent = await login(app, 'finance');
  await agent.postForm('/finance/pledges', { family_id: String(fid), fund_id: '2', amount: '1.000,00' });
  const pledge = db.prepare('SELECT * FROM pledges').get();
  assert.equal(pledge.amount, 100000);

  let res = await agent.postForm('/finance/donations', {
    family_id: String(fid), date: '2025-05-01', method: 'pix', pledge_id: String(pledge.id),
    'splits[0][fund_id]': '2', 'splits[0][amount]': '600,00',
    'splits[1][fund_id]': '1', 'splits[1][amount]': '180',
    'splits[2][fund_id]': '1', 'splits[2][amount]': '',
  });
  assert.equal(res.status, 302);
  const pay = db.prepare('SELECT * FROM payments').get();
  assert.equal(pay.amount, 78000);
  assert.equal(pay.receipt_number, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payment_splits WHERE payment_id = ?').get(pay.id).n, 2);
  assert.equal(db.prepare('SELECT status FROM pledges').get().status, 'open');

  recordDonation(db, { familyId: fid, date: '2025-06-01', pledgeId: pledge.id, splits: [{ fundId: 2, amount: 40000 }] });
  assert.equal(db.prepare('SELECT status FROM pledges').get().status, 'fulfilled');
  assert.equal(db.prepare('SELECT MAX(receipt_number) m FROM payments').get().m, 2);

  res = await agent.get(`/finance/donations/${pay.id}/receipt.pdf`).buffer(true).parse(binary);
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  assert.equal(res.body.subarray(0, 4).toString(), '%PDF');

  res = await agent.postForm('/finance/receipts', { ids: [String(pay.id)] });
  assert.equal(res.headers['content-type'], 'application/pdf');

  res = await agent.postForm('/finance/thank-you', { ids: [String(pay.id)], format: 'docx', mark_thanked: '1' }).buffer(true).parse(binary);
  assert.match(res.headers['content-type'], /wordprocessingml/);
  assert.equal(res.body.subarray(0, 2).toString(), 'PK');
  assert.ok(db.prepare('SELECT thanked_at FROM payments WHERE id = ?').get(pay.id).thanked_at);

  outbox.length = 0;
  res = await agent.postForm('/finance/thank-you', { all_unthanked: '1', format: 'email' });
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].attachments[0].filename, 'receipt.pdf');

  res = await agent.postForm('/finance/year-end', { year: '2025', format: 'pdf' });
  assert.equal(res.headers['content-type'], 'application/pdf');

  res = await agent.get('/finance/payments?format=csv&from=2025-01-01');
  assert.match(res.text, /Cohen/);
});

test('split amounts that do not belong to a fund are rejected', async () => {
  const { db } = setup();
  assert.throws(() => recordDonation(db, { familyId: null, date: '2025-01-01', splits: [] }), /at least one fund/);
});

test('yahrzeit reminders are sent once per observance', async () => {
  const { db } = setup();
  const fid = createFamily(db);
  // A yahrzeit whose next observance is 3 days from today.
  const { HDate } = await import('@hebcal/core');
  const target = new HDate(new Date(addDays(todayISO(), 3) + 'T12:00:00'));
  const origHy = target.getFullYear() - 5;
  const orig = new HDate(target.getDate(), target.getMonth(), origHy);
  const origIso = orig.greg().toISOString().slice(0, 10);
  db.prepare("INSERT INTO occasions (family_id, type, name, gregorian_date, remind_days_before, remind_email, remind_sms) VALUES (?, 'yahrzeit', 'Avraham', ?, 7, 1, 1)").run(fid, origIso);
  outbox.length = 0;
  let stats = await sendDueReminders(db);
  assert.equal(stats.sent, 2);
  assert.deepEqual(outbox.map((m) => m.channel).sort(), ['email', 'sms']);
  assert.match(outbox.find((m) => m.channel === 'email').subject, /Yahrzeit/);
  stats = await sendDueReminders(db);
  assert.equal(stats.sent, 0);
});

test('yahrzeit letters render as PDF and Word', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  const id = db.prepare("INSERT INTO occasions (family_id, type, name, hebrew_name, gregorian_date) VALUES (?, 'yahrzeit', 'Avraham', 'אברהם בן יצחק', ?)").run(fid, addDays(todayISO(), -365 * 3 + 5)).lastInsertRowid;
  const agent = await login(app, 'staff');
  const page = await agent.get('/occasions/yahrzeit-letters?days=60');
  assert.match(page.text, /Avraham/);
  let res = await agent.postForm('/occasions/yahrzeit-letters', { ids: [String(id)], days: '60', format: 'pdf' });
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'application/pdf');
  res = await agent.postForm('/occasions/yahrzeit-letters', { ids: [String(id)], days: '60', format: 'docx' }).buffer(true);
  assert.match(res.headers['content-type'], /wordprocessingml/);
});

test('campaigns respect opt-outs and merge fields', async () => {
  const { db, app } = setup();
  createFamily(db, { family_name: 'Cohen', salutation: 'Dear Cohens' });
  createFamily(db, { family_name: 'Levy', email: 'levy@example.org', no_email: 1 });
  createFamily(db, { family_name: 'Katz', email: null });
  const agent = await login(app, 'staff');
  const preview = await agent.postForm('/comms/preview', { channel: 'email', subject: 'Hi', body: 'Hello {{salutation}}' });
  assert.match(preview.text, /<strong>1<\/strong> recipients/);
  outbox.length = 0;
  const res = await agent.postForm('/comms/send', { channel: 'email', subject: 'Chanukah', body: 'Hello {{salutation}}' });
  assert.equal(res.status, 302);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].to, 'cohen@example.org');
  assert.match(outbox[0].text, /Hello Dear Cohens/);
  outbox.length = 0;
  await agent.postForm('/comms/send', { channel: 'call', body: 'Shabbat Shalom' });
  assert.equal(outbox.length, 3);
  assert.equal(outbox[0].to, '+5541999990000');
});

test('print mailings produce labels, envelopes and Word letters', async () => {
  const { db, app } = setup();
  createFamily(db);
  createFamily(db, { family_name: 'NoAddress', street: null });
  const agent = await login(app, 'staff');
  for (const kind of ['labels', 'envelopes', 'letters-pdf']) {
    const res = await agent.postForm('/comms/print', { kind, letter_body: 'Dear {{salutation}}' });
    assert.equal(res.headers['content-type'], 'application/pdf', kind);
  }
  const res = await agent.postForm('/comms/print', { kind: 'letters-docx', letter_body: 'Dear {{salutation}}' }).buffer(true);
  assert.match(res.headers['content-type'], /wordprocessingml/);
});

test('public event registration counts attendees and enforces capacity', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  db.prepare("INSERT INTO events (slug, name, starts_at, price_adult, price_child, capacity) VALUES ('dinner', 'Dinner', '2099-01-01T19:00', 5000, 2000, 4)").run();
  const agent = request.agent(app);
  const page = await agent.get('/e/dinner');
  const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
  let res = await agent.post('/e/dinner').type('form').send({ _csrf: token, name: 'Moshe Cohen', email: 'COHEN@example.org', adults: '2', children: '1' });
  assert.equal(res.status, 302);
  const reg = db.prepare('SELECT * FROM registrations').get();
  assert.equal(reg.total, 12000);
  assert.equal(reg.status, 'pending');
  assert.equal(reg.family_id, fid);
  res = await agent.post('/e/dinner').type('form').send({ _csrf: token, name: 'Too many', email: 'x@example.org', adults: '2' });
  assert.equal(res.status, 400);

  const staff = await login(app, 'staff');
  await staff.postForm(`/events/1/registrations/${reg.id}/pay`, { method: 'cash' });
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id = ?').get(reg.id).status, 'paid');
  const csv = await staff.get('/events/1?format=csv');
  assert.match(csv.text, /Moshe Cohen/);
});

test('Stripe checkout completion records payments idempotently', () => {
  const { db } = setup();
  const fid = createFamily(db);
  const session = { id: 'cs_1', payment_status: 'paid', amount_total: 18000, customer_details: { email: 'cohen@example.org' }, payment_intent: 'pi_1', metadata: { kind: 'donation', fund_id: '1' } };
  assert.equal(applyCheckoutSession(db, session), 'donation');
  assert.equal(applyCheckoutSession(db, session), 'duplicate');
  const p = db.prepare('SELECT * FROM payments').get();
  assert.equal(p.family_id, fid);
  assert.equal(p.method, 'online');
  assert.ok(p.receipt_number);

  db.prepare("INSERT INTO events (slug, name, starts_at) VALUES ('e', 'E', '2099-01-01T10:00')").run();
  const rid = db.prepare("INSERT INTO registrations (event_id, name, total) VALUES (1, 'X', 5000)").run().lastInsertRowid;
  applyCheckoutSession(db, { id: 'cs_2', payment_status: 'paid', amount_total: 5000, metadata: { kind: 'registration', ref_id: String(rid) } });
  assert.equal(db.prepare('SELECT status FROM registrations WHERE id = ?').get(rid).status, 'paid');
});

test('orders total, procurement summary and payments', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  db.prepare("INSERT INTO products (name, category, season, price) VALUES ('Shmura Matzah 1lb', 'matzah', 'Pesach 5787', 9000), ('Arba Minim set', 'arba_minim', 'Sukkot 5787', 25000)").run();
  const agent = await login(app, 'staff');
  let res = await agent.postForm('/orders', { family_id: String(fid), 'qty[p1]': '3', 'qty[p2]': '1' });
  assert.equal(res.status, 302);
  res = await agent.get('/orders/1');
  assert.match(res.text, /520,00/);
  await agent.postForm('/orders/1/payments', { amount: '270', method: 'pix' });
  res = await agent.get('/orders?season=Pesach%205787');
  assert.match(res.text, /Shmura Matzah 1lb/);
  assert.equal(db.prepare("SELECT SUM(amount) s FROM payments WHERE kind = 'order'").get().s, 27000);
});

test('Google sign-in only admits invited users or configured admins', () => {
  const { db } = setup();
  assert.match(findAdmissible(db, 'stranger@example.org').error, /not been invited/);
  db.prepare("INSERT INTO users (email, role) VALUES ('vol@example.org', 'volunteer')").run();
  assert.equal(findAdmissible(db, 'VOL@example.org').user.role, 'volunteer');
  db.prepare("UPDATE users SET active = 0 WHERE email = 'vol@example.org'").run();
  assert.match(findAdmissible(db, 'vol@example.org').error, /deactivated/);
});

test('admin can invite users and cannot demote themselves', async () => {
  const { db, app } = setup();
  const agent = await login(app, 'admin');
  await agent.postForm('/admin/users', { email: 'New@Example.org', role: 'finance' });
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'new@example.org'").get().role, 'finance');
  const me = db.prepare("SELECT id FROM users WHERE email = 'admin@example.org'").get();
  const res = await agent.postForm(`/admin/users/${me.id}`, { role: 'staff', active: '1' });
  assert.equal(res.status, 400);
  await agent.postForm('/admin/settings', { org_name: 'Beit Chabad Curitiba', custom_fields: 'Shul seat\nkashrut: Keeps kosher' });
  const defs = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'custom_field_defs'").get().value);
  assert.deepEqual(defs.map((d) => d.key), ['shul_seat', 'kashrut']);
  const bk = await agent.postForm('/admin/backups');
  assert.equal(bk.status, 302);
});

test('campaign recipients: all contacts, chosen contacts, or filters', async () => {
  const { db, app } = setup();
  const a = createFamily(db, { family_name: 'Aaron', email: 'a@example.org' });
  const b = createFamily(db, { family_name: 'Baruch', email: 'b@example.org' });
  createFamily(db, { family_name: 'NoMail', email: 'n@example.org', no_email: 1 });
  const agent = await login(app, 'staff');

  const page = await agent.get('/comms/compose?channel=email');
  assert.match(page.text, /All contacts/);
  assert.match(page.text, /Aaron/);
  assert.doesNotMatch(page.text, /NoMail/);

  outbox.length = 0;
  await agent.postForm('/comms/send', { channel: 'email', audience: 'all', q: 'Aaron', subject: 'S', body: 'B' });
  assert.deepEqual(outbox.map((m) => m.to).sort(), ['a@example.org', 'b@example.org']);

  outbox.length = 0;
  await agent.postForm('/comms/send', { channel: 'email', audience: 'pick', familyIds: [String(b)], subject: 'S', body: 'B' });
  assert.deepEqual(outbox.map((m) => m.to), ['b@example.org']);

  outbox.length = 0;
  await agent.postForm('/comms/send', { channel: 'email', audience: 'pick', subject: 'S', body: 'B' });
  assert.equal(outbox.length, 0, 'picking nobody sends nothing');

  outbox.length = 0;
  await agent.postForm('/comms/send', { channel: 'email', audience: 'filter', q: 'Aaron', familyIds: [String(b)], subject: 'S', body: 'B' });
  assert.deepEqual(outbox.map((m) => m.to), ['a@example.org']);

  // Many chosen contacts survive form parsing.
  const ids = [a, b];
  for (let i = 0; i < 40; i++) ids.push(createFamily(db, { family_name: `F${i}`, email: `f${i}@example.org` }));
  const preview = await agent.postForm('/comms/preview', { channel: 'email', audience: 'pick', familyIds: ids.map(String), subject: 'S', body: 'B' });
  assert.match(preview.text, /<strong>42<\/strong> recipients/);
});
