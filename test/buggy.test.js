import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, login, createFamily } from './helpers.js';
import { gemini, pickModel } from '../src/lib/buggy/gemini.js';
import { config } from '../src/config.js';

/** Replaces Gemini with a script of replies; records what Dot sent. */
function fakeGemini(script) {
  const calls = [];
  gemini.enabled = () => true;
  gemini.generate = async (req) => {
    calls.push(JSON.parse(JSON.stringify(req)));
    const next = script.shift();
    if (!next) throw new Error('fake gemini: no more replies');
    return typeof next === 'function' ? next(req) : next;
  };
  return calls;
}
const say = (text) => ({ role: 'model', parts: [{ text }] });
const callTool = (name, args) => ({ role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig-123' }] });

async function chat(agent, text, lang) {
  const res = await agent.post('/assistant/message').set('x-csrf-token', agent.csrfToken).send({ text, lang });
  return res;
}

async function buggyAgent(app, role) {
  const agent = await login(app, role);
  const page = await agent.get('/assistant');
  agent.csrfToken = /data-csrf="([^"]+)"/.exec(page.text)[1];
  return { agent, page };
}

test('Dot creates a contact with a family member right away, without asking', async () => {
  const { db, app } = setup();
  const calls = fakeGemini([
    callTool('search_contacts', { query: 'Joseli' }),
    callTool('create_contact', { family_name: 'Joseli', first_name: 'Joseli', email: 'Joseli@Gmail.com', members: [{ first_name: 'Dimini', relation: 'spouse' }] }),
  ]);
  const { agent, page } = await buggyAgent(app, 'staff');
  assert.match(page.text, /Dot/);
  assert.match(page.text, /dot\.webmanifest/);

  const res = await chat(agent, 'Adiciona Joseli e Dimini aos contatos, email joseli@gmail.com');
  assert.equal(res.status, 200);
  assert.equal(res.body.pending.length, 0, 'no confirmation needed for a new contact');
  assert.equal(res.body.reply, 'Pronto! Contato "Joseli" criado.');
  assert.equal(calls.length, 2, 'the answer needs no extra model call');

  // The tool results went back to the model, and the model reply (with its thought signature) was kept verbatim.
  const second = calls[1].contents;
  assert.equal(second.at(-2).parts[0].thoughtSignature, 'sig-123');
  assert.deepEqual(second.at(-1).parts[0].functionResponse.response.result, { total: 0, contacts: [] });
  assert.ok(calls[0].tools.some((t) => t.name === 'create_contact'));
  assert.ok(!calls[0].tools.some((t) => t.name === 'record_donation'), 'staff cannot record donations');
  assert.match(calls[0].system, /You are Dot/);

  const fam = db.prepare("SELECT * FROM families WHERE family_name = 'Joseli'").get();
  assert.equal(fam.email, 'joseli@gmail.com');
  assert.equal(fam.source, 'Dot');
  const people = db.prepare('SELECT first_name, relation FROM people WHERE family_id = ? ORDER BY id').all(fam.id);
  assert.deepEqual(people, [{ first_name: 'Joseli', relation: 'primary' }, { first_name: 'Dimini', relation: 'spouse' }]);
  assert.equal(res.body.links[0].href, `/families/${fam.id}`);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE details = 'via Dot'").get());
});

test('Dot records donations right away, without asking for confirmation', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  fakeGemini([
    callTool('record_donation', { family_id: fid, amount: 180, method: 'pix' }),
    callTool('record_donation', { family_id: fid, amount: 36.5, fund: 'construção' }),
  ]);
  const { agent } = await buggyAgent(app, 'finance');
  let res = await chat(agent, 'Cohen deu 180 por pix');
  assert.equal(res.body.pending.length, 0);
  assert.equal(db.prepare('SELECT amount, method FROM payments').get().method, 'pix');

  res = await chat(agent, 'Cohen deu 36,50 para o fundo de construção');
  assert.equal(res.body.pending.length, 0);
  const p = db.prepare('SELECT * FROM payments WHERE amount = 3650').get();
  assert.ok(p.receipt_number);
  assert.equal(db.prepare('SELECT f.name FROM payment_splits s JOIN funds f ON f.id = s.fund_id WHERE s.payment_id = ?').get(p.id).name, 'Fundo de Construção');
});

test('Dot refuses tools the user may not use and reports bad input back to the model', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  const calls = fakeGemini([
    callTool('record_donation', { family_id: fid, amount: 100 }),
    say('Desculpe, você não tem permissão para registrar doações.'),
    callTool('create_contact', { family_name: 'X', email: 'not-an-email' }),
    say('Pode soletrar o email?'),
  ]);
  const { agent } = await buggyAgent(app, 'volunteer');
  let res = await chat(agent, 'Registra 100 do Cohen');
  assert.equal(res.body.pending.length, 0);
  assert.match(calls[1].contents.at(-1).parts[0].functionResponse.response.error, /not allowed/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);

  // Volunteers cannot create contacts either.
  res = await chat(agent, 'Cria o contato X');
  assert.match(calls[3].contents.at(-1).parts[0].functionResponse.response.error, /not allowed/);
});

test('Dot adds a Yahrzeit from a Hebrew date and answers lookups', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  const calls = fakeGemini([
    callTool('add_occasion', { family_id: fid, type: 'yahrzeit', name: 'Avraham Cohen', hebrew_day: 5, hebrew_month: 'Cheshvan', hebrew_year: 5786 }),
    callTool('get_contact', { family_id: fid }),
    say('O próximo Yahrzeit é 5 de Cheshvan.'),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  let res = await chat(agent, 'Adiciona o Yahrzeit do Avraham, 5 de Cheshvan 5786');
  assert.equal(res.body.pending.length, 0);
  assert.equal(db.prepare('SELECT gregorian_date FROM occasions').get().gregorian_date, '2025-10-27');
  res = await chat(agent, 'Quando é o Yahrzeit?');
  const result = calls[2].contents.at(-1).parts[0].functionResponse.response.result;
  assert.equal(result.occasions[0].type, 'yahrzeit');
  assert.ok(result.occasions[0].next_hebrew_date.startsWith('5 Cheshvan'));
  assert.equal(result.recent_donations, undefined, 'staff do not see donations');
});

test('Dot page explains setup when no Gemini key is configured', async () => {
  const { app } = setup();
  gemini.enabled = () => false;
  const { agent } = await buggyAgent(app, 'staff');
  const page = await agent.get('/assistant');
  assert.match(page.text, /GEMINI_API_KEY/);
  const res = await chat(agent, 'oi');
  assert.equal(res.status, 503);
});

test('pickModel prefers the newest stable Gemini Flash model', async () => {
  assert.equal(pickModel(['models/gemini-2.5-flash', 'models/gemini-3-flash-preview', 'models/gemini-2.5-pro', 'models/gemini-3-flash', 'models/gemini-3-flash-lite']), 'gemini-3-flash');
  // Stable models come before previews, which are often overloaded.
  assert.equal(pickModel(['models/gemini-2.5-flash', 'models/gemini-3.6-flash-preview']), 'gemini-2.5-flash');
  assert.equal(pickModel(['models/gemini-3.6-flash-preview']), 'gemini-3.6-flash-preview');
  assert.equal(pickModel(['models/text-embedding-004']), null);
  // Flash-Lite models are kept as backups, after the regular Flash models.
  const { rankModels } = await import('../src/lib/buggy/gemini.js');
  assert.deepEqual(rankModels(['models/gemini-3.8-flash-lite', 'models/gemini-3.8-flash', 'models/gemini-3-flash']), ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-3.8-flash-lite']);
});

test('Gemini REST request has the expected shape', async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ url: req.url, key: req.headers['x-goog-api-key'], body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-9-flash', supportedGenerationMethods: ['generateContent'] }] }));
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Olá!' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  Object.assign(config.gemini, { apiKey: 'test-key', model: '', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const { gemini: real } = await import(`../src/lib/buggy/gemini.js?fresh=${Date.now()}`);
    const out = await real.generate({ system: 'sys', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }] });
    assert.deepEqual(out, { role: 'model', parts: [{ text: 'Olá!' }] });
    const gen = received.find((r) => r.url.includes(':generateContent'));
    assert.equal(gen.url, '/models/gemini-9-flash:generateContent');
    assert.equal(gen.key, 'test-key');
    assert.deepEqual(gen.body.systemInstruction, { parts: [{ text: 'sys' }] });
    assert.equal(gen.body.tools[0].functionDeclarations[0].name, 't');
    assert.deepEqual(gen.body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  } finally {
    Object.assign(config.gemini, saved);
    server.close();
  }
});

test('Gemini busy: retries, then falls back to the next model; a failed turn is forgotten', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) {
        return res.end(JSON.stringify({ models: ['gemini-9-flash', 'gemini-8-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }));
      }
      if (req.url.includes('gemini-9-flash') || server.allBusy) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }));
      }
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Oi!' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  Object.assign(config.gemini, { apiKey: 'k', model: '', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const mod = await import(`../src/lib/buggy/gemini.js?busy=${Date.now()}`);
    mod.gemini.retryDelays = [1, 1];
    const req = { system: 's', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [] };
    const out = await mod.gemini.generate(req);
    assert.equal(out.parts[0].text, 'Oi!');
    assert.equal(hits.filter((u) => u.includes('gemini-9-flash:')).length, 1, 'a busy model is not retried while others are available');
    // The busy model is skipped on the next request.
    hits.length = 0;
    await mod.gemini.generate(req);
    assert.deepEqual(hits.filter((u) => u.includes(':generateContent')), ['/models/gemini-8-flash:generateContent']);

    // Everything busy: a friendly error, and the conversation does not keep the failed message.
    server.allBusy = true;
    await assert.rejects(mod.gemini.generate(req), /ocupados/);
    const { handleMessage, newState } = await import('../src/lib/buggy/agent.js');
    const { gemini: shared } = await import('../src/lib/buggy/gemini.js');
    shared.generate = async () => { throw Object.assign(new Error('Os servidores do Google estão ocupados agora.'), { busy: true }); };
    const state = newState();
    const { db } = setup();
    await assert.rejects(handleMessage(db, { id: 1, role: 'admin', active: 1 }, state, 'oi'), /ocupados/);
    assert.equal(state.contents.length, 0);
  } finally {
    Object.assign(config.gemini, saved);
    server.close();
  }
});

test('Dot can be installed as an app: manifest and root service worker are served', async () => {
  const { app } = setup();
  const request = (await import('supertest')).default;
  const sw = await request(app).get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers['content-type'], /javascript/);
  assert.match(sw.text, /addEventListener\('fetch'/);
  const m = await request(app).get('/static/dot.webmanifest');
  const manifest = JSON.parse(m.text);
  assert.equal(manifest.name, 'Dot');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.icons.some((i) => i.sizes === '512x512'));
});

test('create_contact warns about similar contacts and lets the model ask first', async () => {
  const { db, app } = setup();
  createFamily(db, { family_name: 'Saverman', email: 'jamile@gmail.com' });
  const calls = fakeGemini([
    callTool('create_contact', { family_name: 'Saverman', first_name: 'Jamile', email: 'jamile@gmail.com' }),
    say('Já existe uma família Saverman com esse email. É a mesma pessoa?'),
    callTool('create_contact', { family_name: 'Saverman', first_name: 'Jamile', email: 'jamile@gmail.com', confirmed_new: true }),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  let res = await chat(agent, 'Add Jamile Saverman, jamile@gmail.com');
  assert.equal(res.body.pending.length, 0);
  assert.match(res.body.reply, /Já existe/);
  const warning = calls[1].contents.at(-1).parts[0].functionResponse.response.warning;
  assert.equal(warning.similar[0].family_name, 'Saverman');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Saverman'").get().n, 1, 'nothing created while asking');
  res = await chat(agent, 'Cria um novo mesmo assim');
  assert.equal(res.body.pending.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Saverman'").get().n, 2);
});

test('thinking is kept minimal for each Gemini generation', async () => {
  const { thinkingConfigFor } = await import('../src/lib/buggy/gemini.js');
  assert.deepEqual(thinkingConfigFor('gemini-2.5-flash'), { thinkingBudget: 0 });
  assert.deepEqual(thinkingConfigFor('gemini-3-flash'), { thinkingLevel: 'low' });
  assert.equal(thinkingConfigFor('custom-model'), null);
});

test('a model that rejects the thinking setting is retried without it', async () => {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-3-flash', supportedGenerationMethods: ['generateContent'] }] }));
      const parsed = JSON.parse(body);
      bodies.push(parsed);
      if (parsed.generationConfig.thinkingConfig) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { code: 400, message: 'Invalid value at generation_config.thinking_config.thinking_level' } }));
      }
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  Object.assign(config.gemini, { apiKey: 'k', model: '', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const mod = await import(`../src/lib/buggy/gemini.js?think=${Date.now()}`);
    const req = { system: 's', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [] };
    assert.equal((await mod.gemini.generate(req)).parts[0].text, 'ok');
    assert.equal(bodies.length, 2);
    await mod.gemini.generate(req);
    assert.equal(bodies.length, 3, 'remembered: no failed attempt the second time');
  } finally {
    Object.assign(config.gemini, saved);
    server.close();
  }
});

test('a Gemini model that never answers is abandoned quickly for the next one', async () => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) {
        return res.end(JSON.stringify({ models: ['gemini-9-flash', 'gemini-8-flash'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }));
      }
      if (req.url.includes('gemini-9-flash')) return; // hangs forever
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'rápido' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  Object.assign(config.gemini, { apiKey: 'k', model: '', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const mod = await import(`../src/lib/buggy/gemini.js?hang=${Date.now()}`);
    mod.gemini.requestTimeoutMs = 300;
    const started = Date.now();
    const out = await mod.gemini.generate({ system: 's', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [] });
    assert.equal(out.parts[0].text, 'rápido');
    assert.ok(Date.now() - started < 2000, 'no repeated waits on the hanging model');
  } finally {
    Object.assign(config.gemini, saved);
    server.closeAllConnections();
    server.close();
  }
});

test('progress steps are streamed while Dot works, then the result', async () => {
  const { db, app } = setup();
  fakeGemini([
    callTool('search_contacts', { query: 'Cohen' }),
    callTool('create_contact', { family_name: 'Novo', email: 'novo@example.org' }),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  const res = await agent.post('/assistant/message').set('x-csrf-token', agent.csrfToken)
    .set('accept', 'application/x-ndjson').send({ text: 'Adiciona Novo' }).buffer(true).parse((r, cb) => {
      let t = ''; r.on('data', (c) => { t += c; }); r.on('end', () => cb(null, t));
    });
  assert.match(res.headers['content-type'], /ndjson/);
  const lines = res.body.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.filter((l) => l.step).map((l) => l.step), ['thinking', 'searching', 'thinking', 'creating_contact']);
  assert.equal(lines.at(-1).result.pending.length, 0);
  assert.match(lines.at(-1).result.reply, /^Pronto!/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Novo'").get().n, 1);
  // The conversation survived the streamed response (session saved).
  fakeGemini([say('Ok!')]);
  const next = await chat(agent, 'obrigado');
  assert.equal(next.body.reply, 'Ok!');
});

test('a retired Gemini model is skipped and the replacement Google suggests is used', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) return res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] }));
      if (req.url.includes('gemini-2.5-flash')) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: { code: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features.' } }));
      }
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'olá' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  // The configured model is the retired one, as in a real setup.
  Object.assign(config.gemini, { apiKey: 'k', model: 'gemini-2.5-flash', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const mod = await import(`../src/lib/buggy/gemini.js?retired=${Date.now()}`);
    const req = { system: 's', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [] };
    assert.equal((await mod.gemini.generate(req)).parts[0].text, 'olá');
    assert.ok(hits.includes('/models/gemini-3.8-flash:generateContent'));
    hits.length = 0;
    await mod.gemini.generate(req);
    assert.deepEqual(hits.filter((u) => u.includes(':generateContent')), ['/models/gemini-3.8-flash:generateContent'], 'retired model not tried again');
  } finally {
    Object.assign(config.gemini, saved);
    server.close();
  }
});

test('when every Flash model is busy, a Flash-Lite backup answers', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push(req.url);
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/models?')) {
        return res.end(JSON.stringify({ models: ['gemini-3.8-flash', 'gemini-3-flash', 'gemini-3.8-flash-lite'].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }));
      }
      if (!req.url.includes('lite')) {
        res.statusCode = 503;
        return res.end(JSON.stringify({ error: { code: 503, message: 'This model is currently experiencing high demand.' } }));
      }
      res.end(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'lite ok' }] } }] }));
    });
  });
  await new Promise((r) => server.listen(0, r));
  const saved = { ...config.gemini };
  Object.assign(config.gemini, { apiKey: 'k', model: '', baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const mod = await import(`../src/lib/buggy/gemini.js?lite=${Date.now()}`);
    mod.gemini.retryDelays = [1, 1];
    const started = Date.now();
    const out = await mod.gemini.generate({ system: 's', contents: [{ role: 'user', parts: [{ text: 'oi' }] }], tools: [] });
    assert.equal(out.parts[0].text, 'lite ok');
    assert.deepEqual(hits.filter((u) => u.includes(':generateContent')), [
      '/models/gemini-3.8-flash:generateContent', '/models/gemini-3-flash:generateContent', '/models/gemini-3.8-flash-lite:generateContent',
    ]);
    assert.ok(Date.now() - started < 1000);
  } finally {
    Object.assign(config.gemini, saved);
    server.close();
  }
});

test('Dot answers in the language chosen on the page', async () => {
  const { db, app } = setup();
  const calls = fakeGemini([
    callTool('create_contact', { family_name: 'Edward', email: 'edward@gmail.com' }),
    callTool('create_contact', { family_name: 'Levi', members: [{ first_name: 'Dina', relation: 'spouse' }] }),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  const send = (text, lang) => agent.post('/assistant/message').set('x-csrf-token', agent.csrfToken).send({ text, lang });

  let res = await send('add Edward, edward@gmail.com', 'en-US');
  assert.match(calls[0].system, /Always reply in English/);
  assert.equal(res.body.reply, 'Done! Contact "Edward" created.');

  res = await send('תוסיף את משפחת לוי עם דינה', 'he-IL');
  assert.match(calls[1].system, /Always reply in Hebrew/);
  assert.equal(res.body.reply, 'בוצע! איש הקשר "Levi" נוצר.');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name IN ('Edward', 'Levi')").get().n, 2);

  // Saved changes and errors follow the language too.
  const fid = db.prepare("SELECT id FROM families WHERE family_name = 'Edward'").get().id;
  fakeGemini([callTool('add_occasion', { family_id: fid, type: 'yahrzeit', name: 'Avraham', date: '2020-03-15' })]);
  res = await send('add yahrzeit', 'en-US');
  assert.equal(res.body.reply, 'Done! Yahrzeit of Avraham added.');
  res = await agent.post('/assistant/confirm').set('x-csrf-token', agent.csrfToken).send({ decision: 'no', lang: 'en-US' });
  assert.equal(res.body.reply, 'Nothing is waiting for confirmation.');
  gemini.generate = async () => { throw Object.assign(new Error('busy'), { busy: true }); };
  res = await send('hello', 'en-US');
  assert.match(res.body.error, /Google's servers are busy/);
});

test('create_contact saves without asking in English and Hebrew, even with a shared last name', async () => {
  const { db, app } = setup();
  const cohen = createFamily(db, { family_name: 'Cohen', email: 'moshe@example.org' });
  db.prepare("INSERT INTO people (family_id, relation, first_name) VALUES (?, 'primary', 'Moshe')").run(cohen);
  fakeGemini([
    callTool('create_contact', { family_name: 'Cohen', first_name: 'Sarah', email: 'sarah@example.org' }),
    callTool('create_contact', { family_name: 'Levi', first_name: 'David' }),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  let res = await chat(agent, 'Add Sarah Cohen, sarah@example.org', 'en-US');
  assert.equal(res.body.pending.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Cohen'").get().n, 2);
  res = await chat(agent, 'תוסיף את דוד לוי', 'he-IL');
  assert.equal(res.body.pending.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Levi'").get().n, 1);
});

test('when the model asks permission to add a contact, Dot tells it to save instead', async () => {
  const { db, app } = setup();
  const calls = fakeGemini([
    say('Would you like me to add John Smith to your contacts?'),
    callTool('create_contact', { family_name: 'Smith', first_name: 'John' }),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  const res = await chat(agent, 'Add John Smith', 'en-US');
  assert.equal(res.body.pending.length, 0);
  assert.doesNotMatch(res.body.reply, /Would you like/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Smith'").get().n, 1);
  const sent = calls[1].contents;
  assert.ok(!sent.some((c) => c.role === 'model' && JSON.stringify(c).includes('Would you like')), 'the question is dropped');
  assert.match(sent.at(-1).parts.at(-1).text, /Do not ask/);
  const page = await agent.get('/assistant');
  assert.doesNotMatch(page.text, /Nota do sistema|Do not ask/);
});

test('a normal question is not nudged', async () => {
  const { app } = setup();
  const calls = fakeGemini([say('Which Cohen do you mean?')]);
  const { agent } = await buggyAgent(app, 'staff');
  const res = await chat(agent, 'What is the phone of Cohen?', 'en-US');
  assert.match(res.body.reply, /Which Cohen/);
  assert.equal(calls.length, 1);
});

test('add_family_member saves right away, and asks only when the name is already in the family', async () => {
  const { db, app } = setup();
  const fid = createFamily(db, { family_name: 'Stolik' });
  db.prepare("INSERT INTO people (family_id, relation, first_name) VALUES (?, 'primary', 'Moshe')").run(fid);
  const calls = fakeGemini([
    callTool('add_family_member', { family_id: fid, first_name: 'Yeho', relation: 'child' }),
    callTool('add_family_member', { family_id: fid, first_name: 'moshe', relation: 'child' }),
    say('Stolik already has a Moshe. Is it the same person?'),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  let res = await chat(agent, 'Add yeho to stolik family', 'en-US');
  assert.equal(res.body.pending.length, 0);
  assert.match(res.body.reply, /Yeho added to the Stolik family/);
  assert.equal(db.prepare("SELECT relation FROM people WHERE family_id = ? AND first_name = 'Yeho'").get(fid).relation, 'child');
  res = await chat(agent, 'Add Moshe to the Stolik family', 'en-US');
  assert.equal(res.body.pending.length, 0);
  assert.ok(calls[2].contents.at(-1).parts[0].functionResponse.response.warning);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM people WHERE family_id = ? AND first_name = 'Moshe' COLLATE NOCASE").get(fid).n, 1);
});
