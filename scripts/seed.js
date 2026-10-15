// Loads demo data so the system can be explored. Usage: npm run seed
import { openDb } from '../src/db/index.js';
import { recordDonation } from '../src/lib/finance.js';
import { todayISO, addDays } from '../src/lib/hebrew.js';

const db = openDb();
if (db.prepare('SELECT COUNT(*) n FROM families').get().n > 0) {
  console.log('Database already has contacts; skipping seed.');
  process.exit(0);
}

const today = todayISO();
const cat = (name, parent = null) => Number(db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(name, parent).lastInsertRowid);
const mailings = cat('Mailings');
const pesach = cat('Pesach appeal', mailings);
const rosh = cat('Rosh Hashana cards', mailings);
const programs = cat('Programs');
const youth = cat('Youth', programs);
const womens = cat("Women's circle", programs);
const board = cat('Board');

const families = [
  { family_name: 'Cohen', salutation: 'Mr. & Mrs. David Cohen', email: 'cohen@example.org', mobile: '(41) 99911-1111', cep: '80420000', street: 'Rua Comendador Araújo', number: '500', neighborhood: 'Batel', city: 'Curitiba', state: 'PR', affiliation: 'Member', priority: 1, source: 'Shabbat dinner', cats: [pesach, rosh, board] },
  { family_name: 'Levy', salutation: 'Dr. Sarah Levy', email: 'levy@example.org', mobile: '(41) 99922-2222', cep: '80240000', street: 'Av. Sete de Setembro', number: '3000', complement: 'ap 81', neighborhood: 'Água Verde', city: 'Curitiba', state: 'PR', affiliation: 'Member', priority: 2, source: 'Website', cats: [rosh, womens] },
  { family_name: 'Goldberg', salutation: 'Goldberg Family', email: 'goldberg@example.org', mobile: '(41) 99933-3333', cep: '80530000', street: 'Rua Mateus Leme', number: '120', neighborhood: 'São Francisco', city: 'Curitiba', state: 'PR', affiliation: 'Friend', priority: 3, source: 'Referral', cats: [youth] },
  { family_name: 'Katz', salutation: 'Mr. Yossi Katz', email: 'katz@example.org', mobile: '(11) 98888-4444', street: 'Rua Augusta', number: '1500', city: 'São Paulo', state: 'SP', cep: '01304001', affiliation: 'Alumni', priority: 4, source: 'Tourist', cats: [] },
  { family_name: 'Friedman', salutation: 'Mrs. Rivka Friedman', email: 'friedman@example.org', mobile: '(41) 99955-5555', cep: '82010000', street: 'Rua Padre Anchieta', number: '2000', neighborhood: 'Bigorrilho', city: 'Curitiba', state: 'PR', affiliation: 'Member', priority: 2, source: 'Chanukah event', cats: [pesach, womens] },
];

const insFam = db.prepare(`INSERT INTO families (family_name, salutation, email, mobile, cep, street, number, complement, neighborhood, city, state, affiliation, priority, source)
  VALUES (@family_name, @salutation, @email, @mobile, @cep, @street, @number, @complement, @neighborhood, @city, @state, @affiliation, @priority, @source)`);
const ids = {};
for (const f of families) {
  const id = Number(insFam.run({ complement: null, neighborhood: null, ...f, cats: undefined }).lastInsertRowid);
  ids[f.family_name] = id;
  for (const c of f.cats) db.prepare('INSERT INTO family_categories VALUES (?, ?)').run(id, c);
}

const person = db.prepare(`INSERT INTO people (family_id, relation, first_name, last_name, hebrew_name, father_hebrew_name, gender, birth_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
person.run(ids.Cohen, 'primary', 'David', 'Cohen', 'דוד', 'אברהם', 'M', '1975-04-12');
person.run(ids.Cohen, 'spouse', 'Miriam', 'Cohen', 'מרים', 'יעקב', 'F', '1978-09-30');
person.run(ids.Cohen, 'child', 'Yaakov', 'Cohen', 'יעקב', 'דוד', 'M', '2013-11-02');
person.run(ids.Levy, 'primary', 'Sarah', 'Levy', 'שרה', 'משה', 'F', '1982-01-20');
person.run(ids.Goldberg, 'primary', 'Daniel', 'Goldberg', 'דניאל', 'יוסף', 'M', '1990-07-07');
person.run(ids.Goldberg, 'child', 'Esther', 'Goldberg', 'אסתר', 'דניאל', 'F', '2014-03-15');
person.run(ids.Katz, 'primary', 'Yossi', 'Katz', 'יוסף', 'שמואל', 'M', '1988-12-01');
person.run(ids.Friedman, 'primary', 'Rivka', 'Friedman', 'רבקה', 'אהרן', 'F', '1960-05-05');

const occ = db.prepare(`INSERT INTO occasions (family_id, type, name, hebrew_name, relationship, gregorian_date, after_sunset, remind_days_before, remind_sms)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
occ.run(ids.Cohen, 'yahrzeit', 'Avraham Cohen', 'אברהם בן יצחק', 'father of David', addDays(today, -365 * 8 + 6), 0, 7, 1);
occ.run(ids.Levy, 'yahrzeit', 'Moshe Levy', 'משה בן שלמה', 'father of Sarah', addDays(today, -365 * 3 + 20), 1, 10, 0);
occ.run(ids.Friedman, 'yahrzeit', 'Aharon Friedman', 'אהרן בן ישראל', 'husband of Rivka', '2015-02-10', 0, 7, 0);
occ.run(ids.Cohen, 'anniversary', 'David & Miriam', null, 'wedding', '2005-06-20', 0, 3, 0);
occ.run(ids.Cohen, 'bar_mitzvah', 'Yaakov Cohen', 'יעקב בן דוד', 'son', '2013-11-02', 0, 30, 0);
occ.run(ids.Goldberg, 'bat_mitzvah', 'Esther Goldberg', 'אסתר בת דניאל', 'daughter', '2014-03-15', 0, 30, 0);

const year = today.slice(0, 4);
recordDonation(db, { familyId: ids.Cohen, date: `${year}-01-15`, method: 'pix', splits: [{ fundId: 1, amount: 180000 }, { fundId: 2, amount: 360000 }] });
recordDonation(db, { familyId: ids.Levy, date: `${year}-03-02`, method: 'card', splits: [{ fundId: 3, amount: 72000 }] });
recordDonation(db, { familyId: ids.Friedman, date: `${year}-04-10`, method: 'check', reference: '000123', splits: [{ fundId: 1, amount: 50000 }] });
recordDonation(db, { familyId: ids.Cohen, date: `${Number(year) - 1}-12-20`, method: 'transfer', splits: [{ fundId: 1, amount: 100000 }] });
db.prepare('INSERT INTO pledges (family_id, fund_id, amount, date, due_date) VALUES (?, 2, 1000000, ?, ?)').run(ids.Goldberg, `${year}-02-01`, `${year}-12-31`);

const prod = db.prepare('INSERT INTO products (name, category, season, price) VALUES (?, ?, ?, ?)');
prod.run('Shmura Matzah (1 lb)', 'matzah', `Pesach ${Number(year) + 3761}`, 9500);
prod.run('Arba Minim set – standard', 'arba_minim', `Sukkot ${Number(year) + 3761}`, 28000);
prod.run('Arba Minim set – mehudar', 'arba_minim', `Sukkot ${Number(year) + 3761}`, 45000);
prod.run('Tefillin – check by sofer', 'tefillin', null, 15000);
const order = Number(db.prepare('INSERT INTO orders (family_id, date) VALUES (?, ?)').run(ids.Cohen, today).lastInsertRowid);
db.prepare('INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?, 1, 3, 9500), (?, 2, 1, 28000)').run(order, order);

const ev = db.prepare('INSERT INTO events (slug, name, type, starts_at, location, description, price_adult, price_student, price_child, capacity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
const dinner = Number(ev.run('community-shabbat-dinner', 'Community Shabbat Dinner', 'dinner', `${addDays(today, 9)}T19:30`, 'Beit Chabad', 'Join us for a warm Shabbat dinner with the community.', 8000, 4000, 3000, 80).lastInsertRowid);
ev.run('tanya-class', 'Weekly Tanya class', 'class', `${addDays(today, 3)}T20:00`, 'Beit Chabad library', null, 0, 0, 0, null);
const reg = db.prepare('INSERT INTO registrations (event_id, family_id, name, email, adults, students, children, total, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
reg.run(dinner, ids.Cohen, 'David Cohen', 'cohen@example.org', 2, 0, 1, 19000, 'paid');
reg.run(dinner, ids.Levy, 'Sarah Levy', 'levy@example.org', 1, 1, 0, 12000, 'pending');

db.prepare("UPDATE settings SET value = 'Beit Chabad Curitiba' WHERE key = 'org_name'").run();
db.prepare("UPDATE settings SET value = 'Rua Exemplo, 100 - Curitiba/PR' WHERE key = 'org_address'").run();
db.prepare("UPDATE settings SET value = 'Rabbi Example' WHERE key = 'signature_name'").run();
console.log('Demo data loaded.');
