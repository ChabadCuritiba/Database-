import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, login, createFamily, csrfFrom } from './helpers.js';
import { parseCsv, guessMapping, rowToContact } from '../src/lib/csvImport.js';

test('parseCsv handles semicolons, quotes, BOM and CRLF', () => {
  const csv = '﻿Nome;Email;Obs\r\nDavid Cohen;david@x.com;"tem ; ponto e vírgula"\r\n"Levy, Sarah";s@x.com;"diz ""olá"""\r\n\r\n';
  const { delimiter, header, rows } = parseCsv(csv);
  assert.equal(delimiter, ';');
  assert.deepEqual(header, ['Nome', 'Email', 'Obs']);
  assert.deepEqual(rows, [['David Cohen', 'david@x.com', 'tem ; ponto e vírgula'], ['Levy, Sarah', 's@x.com', 'diz "olá"']]);
  assert.equal(parseCsv('a,b\n1,2').delimiter, ',');
});

test('column names are matched in Portuguese and English, including our own export', () => {
  assert.deepEqual(guessMapping(['Sobrenome', 'Primeiro nome', 'E-mail', 'Celular', 'Cidade', 'CEP', 'Coluna estranha']),
    ['family_name', 'first_name', 'email', 'mobile', 'city', 'cep', '']);
  assert.deepEqual(guessMapping(['ID', 'Family', 'Salutation', 'People', 'Email', 'Phone', 'Mobile', 'Address', 'City', 'State', 'CEP', 'Affiliation', 'Priority', 'Source', 'Categories']),
    ['', 'family_name', 'salutation', '', 'email', 'phone', 'mobile', 'street', 'city', 'state', 'cep', 'affiliation', 'priority', 'source', 'categories']);
  const v = rowToContact(['Ana Maria Souza', 'ANA@X.COM', '80.020-000', '9'], ['full_name', 'email', 'cep', 'priority']);
  assert.deepEqual(v, { first_name: 'Ana Maria', family_name: 'Souza', email: 'ana@x.com', cep: '80020000', priority: null });
});

test('contacts are imported from CSV, duplicates skipped or completed, categories created', async () => {
  const { db, app } = setup();
  createFamily(db, { family_name: 'Cohen', email: 'david@example.com', city: null, mobile: '41999990000' });
  const agent = await login(app, 'staff');
  const page = await agent.get('/families/import');
  assert.equal(page.status, 200);
  const csv = [
    'Sobrenome;Primeiro nome;Cônjuge;Email;Celular;Cidade;Categorias',
    'Cohen;David;;david@example.com;;Curitiba;Board',
    'Levy;Sarah;Daniel;sarah@example.com;(41) 98888-0000;Londrina;"Pessach; Newsletter"',
    ';;;;;;',
    ';Sem;;sem@x.com;;;',
    'Katz;Yossi;;nao-e-email;;;',
    'Goldberg;Ruth;;;;São Paulo;',
  ].join('\r\n');

  const preview = await agent.postForm('/families/import/preview', { csv });
  assert.equal(preview.status, 200);
  assert.match(preview.text, /Import 5 rows/, "the fully empty line is ignored");
  assert.match(preview.text, /<option value="family_name" selected>/);

  const mapping = { map_0: 'family_name', map_1: 'first_name', map_2: 'spouse', map_3: 'email', map_4: 'mobile', map_5: 'city', map_6: 'categories' };
  let res = await agent.postForm('/families/import', { csv, duplicates: 'skip', ...mapping });
  assert.equal(res.status, 200);
  assert.match(res.text, /<span>2<\/span>contacts created/);
  assert.match(res.text, /<span>1<\/span>existing contacts|<span>0<\/span>existing contacts/);
  assert.match(res.text, /No name/);
  assert.match(res.text, /Invalid email &#34;nao-e-email&#34;/);

  const levy = db.prepare("SELECT * FROM families WHERE family_name = 'Levy'").get();
  assert.equal(levy.email, 'sarah@example.com');
  assert.equal(levy.city, 'Londrina');
  assert.deepEqual(db.prepare('SELECT first_name, relation FROM people WHERE family_id = ? ORDER BY id').all(levy.id),
    [{ first_name: 'Sarah', relation: 'primary' }, { first_name: 'Daniel', relation: 'spouse' }]);
  const cats = db.prepare('SELECT c.name FROM family_categories fc JOIN categories c ON c.id = fc.category_id WHERE fc.family_id = ? ORDER BY c.name').all(levy.id).map((c) => c.name);
  assert.deepEqual(cats, ['Newsletter', 'Pessach']);
  // Skipped duplicate: Cohen's empty city stays empty.
  assert.equal(db.prepare("SELECT city FROM families WHERE email = 'david@example.com'").get().city, null);

  // Second run with "fill in missing details": Cohen gets the city, nothing is created twice.
  res = await agent.postForm('/families/import', { csv, duplicates: 'update', ...mapping });
  assert.equal(db.prepare("SELECT city FROM families WHERE email = 'david@example.com'").get().city, 'Curitiba');
  assert.equal(db.prepare("SELECT mobile FROM families WHERE email = 'david@example.com'").get().mobile, '41999990000', 'existing values are kept');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Levy'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Goldberg'").get().n, 2, 'no email, so not a duplicate');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'import'").get());

  res = await agent.postForm('/families/import', { csv, map_0: 'email' });
  assert.equal(res.status, 400);
});

test('only users who can edit contacts may import', async () => {
  const { app } = setup();
  const agent = await login(app, 'volunteer');
  assert.equal((await agent.get('/families/import')).status, 403);
  const page = await agent.get('/families');
  const res = await agent.post('/families/import').type('form').send({ _csrf: csrfFrom(page.text), csv: 'a\nb' });
  assert.equal(res.status, 403);
});
