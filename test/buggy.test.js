import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setup, login, createFamily } from './helpers.js';
import { gemini, pickModel } from '../src/lib/buggy/gemini.js';
import { config } from '../src/config.js';

/** Replaces Gemini with a script of replies; records what Buggy sent. */
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

async function chat(agent, text) {
  const res = await agent.post('/assistant/message').set('x-csrf-token', agent.csrfToken).send({ text });
  return res;
}

async function buggyAgent(app, role) {
  const agent = await login(app, role);
  const page = await agent.get('/assistant');
  agent.csrfToken = /data-csrf="([^"]+)"/.exec(page.text)[1];
  return { agent, page };
}

test('Buggy adds a contact with a family member only after confirmation', async () => {
  const { db, app } = setup();
  const calls = fakeGemini([
    callTool('search_contacts', { query: 'Joseli' }),
    callTool('create_contact', { family_name: 'Joseli', first_name: 'Joseli', email: 'Joseli@Gmail.com', members: [{ first_name: 'Dimini', relation: 'spouse' }] }),
  ]);
  const { agent, page } = await buggyAgent(app, 'staff');
  assert.match(page.text, /Buggy/);
  assert.match(page.text, /buggy\.webmanifest/);

  let res = await chat(agent, 'Adiciona Joseli e Dimini aos contatos, email joseli@gmail.com');
  assert.equal(res.status, 200);
  assert.equal(res.body.pending.length, 1);
  assert.match(res.body.pending[0].summary, /Criar contato "Joseli".*joseli@gmail\.com.*Dimini \(cônjuge\)/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Joseli'").get().n, 0, 'nothing saved before confirming');
  assert.equal(calls.length, 2, 'the confirmation question needs no extra model call');
  assert.match(res.body.reply, /Criar contato "Joseli".*Confirma\?$/);

  // The tool results went back to the model, and the model reply (with its thought signature) was kept verbatim.
  const second = calls[1].contents;
  assert.equal(second.at(-2).parts[0].thoughtSignature, 'sig-123');
  assert.deepEqual(second.at(-1).parts[0].functionResponse.response.result, { total: 0, contacts: [] });
  assert.ok(calls[0].tools.some((t) => t.name === 'create_contact'));
  assert.ok(!calls[0].tools.some((t) => t.name === 'record_donation'), 'staff cannot record donations');
  assert.match(calls[0].system, /You are Buggy/);

  res = await chat(agent, 'sim');
  assert.match(res.body.reply, /Pronto!.*Joseli/);
  const fam = db.prepare("SELECT * FROM families WHERE family_name = 'Joseli'").get();
  assert.equal(fam.email, 'joseli@gmail.com');
  assert.equal(fam.source, 'Buggy');
  const people = db.prepare('SELECT first_name, relation FROM people WHERE family_id = ? ORDER BY id').all(fam.id);
  assert.deepEqual(people, [{ first_name: 'Joseli', relation: 'primary' }, { first_name: 'Dimini', relation: 'spouse' }]);
  assert.equal(res.body.links[0].href, `/families/${fam.id}`);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE details = 'via Buggy'").get());
});

test('Buggy: cancelling saves nothing; confirm buttons work', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  fakeGemini([
    callTool('record_donation', { family_id: fid, amount: 180, method: 'pix' }),
    callTool('record_donation', { family_id: fid, amount: 36.5, fund: 'construção' }),
  ]);
  const { agent } = await buggyAgent(app, 'finance');
  let res = await chat(agent, 'Cohen deu 180 por pix');
  assert.match(res.body.pending[0].summary, /R\$\s180,00 de Cohen, fundo Geral, via PIX/);
  res = await agent.post('/assistant/confirm').set('x-csrf-token', agent.csrfToken).send({ decision: 'no' });
  assert.match(res.body.reply, /cancelado/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 0);

  res = await chat(agent, 'Cohen deu 36,50 para o fundo de construção');
  assert.match(res.body.pending[0].summary, /Fundo de Construção/);
  res = await agent.post('/assistant/confirm').set('x-csrf-token', agent.csrfToken).send({ decision: 'yes' });
  const p = db.prepare('SELECT * FROM payments').get();
  assert.equal(p.amount, 3650);
  assert.ok(p.receipt_number);
});

test('Buggy refuses tools the user may not use and reports bad input back to the model', async () => {
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

test('Buggy adds a Yahrzeit from a Hebrew date and answers lookups', async () => {
  const { db, app } = setup();
  const fid = createFamily(db);
  const calls = fakeGemini([
    callTool('add_occasion', { family_id: fid, type: 'yahrzeit', name: 'Avraham Cohen', hebrew_day: 5, hebrew_month: 'Cheshvan', hebrew_year: 5786 }),
    callTool('get_contact', { family_id: fid }),
    say('O próximo Yahrzeit é 5 de Cheshvan.'),
  ]);
  const { agent } = await buggyAgent(app, 'staff');
  let res = await chat(agent, 'Adiciona o Yahrzeit do Avraham, 5 de Cheshvan 5786');
  assert.match(res.body.pending[0].summary, /Yahrzeit de Avraham Cohen \(2025-10-27 = 5 Cheshvan, 5786\)/);
  res = await chat(agent, 'pode');
  assert.equal(db.prepare('SELECT gregorian_date FROM occasions').get().gregorian_date, '2025-10-27');
  res = await chat(agent, 'Quando é o Yahrzeit?');
  const result = calls[2].contents.at(-1).parts[0].functionResponse.response.result;
  assert.equal(result.occasions[0].type, 'yahrzeit');
  assert.ok(result.occasions[0].next_hebrew_date.startsWith('5 Cheshvan'));
  assert.equal(result.recent_donations, undefined, 'staff do not see donations');
});

test('Buggy page explains setup when no Gemini key is configured', async () => {
  const { app } = setup();
  gemini.enabled = () => false;
  const { agent } = await buggyAgent(app, 'staff');
  const page = await agent.get('/assistant');
  assert.match(page.text, /GEMINI_API_KEY/);
  const res = await chat(agent, 'oi');
  assert.equal(res.status, 503);
});

test('pickModel prefers the newest stable Gemini Flash model', () => {
  assert.equal(pickModel(['models/gemini-2.5-flash', 'models/gemini-3-flash-preview', 'models/gemini-2.5-pro', 'models/gemini-3-flash', 'models/gemini-3-flash-lite']), 'gemini-3-flash');
  // Stable models come before previews, which are often overloaded.
  assert.equal(pickModel(['models/gemini-2.5-flash', 'models/gemini-3.6-flash-preview']), 'gemini-2.5-flash');
  assert.equal(pickModel(['models/gemini-3.6-flash-preview']), 'gemini-3.6-flash-preview');
  assert.equal(pickModel(['models/text-embedding-004']), null);
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
    assert.equal(hits.filter((u) => u.includes('gemini-9-flash:')).length, 3, 'busy model tried 3 times');
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

test('Buggy can be installed as an app: manifest and root service worker are served', async () => {
  const { app } = setup();
  const request = (await import('supertest')).default;
  const sw = await request(app).get('/sw.js');
  assert.equal(sw.status, 200);
  assert.match(sw.headers['content-type'], /javascript/);
  assert.match(sw.text, /addEventListener\('fetch'/);
  const m = await request(app).get('/static/buggy.webmanifest');
  const manifest = JSON.parse(m.text);
  assert.equal(manifest.name, 'Buggy');
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
  res = await chat(agent, 'Cria um novo mesmo assim');
  assert.equal(res.body.pending.length, 1);
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

test('progress steps are streamed while Buggy works, then the result', async () => {
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
  assert.equal(lines.at(-1).result.pending.length, 1);
  // The pending change survived the streamed response (session saved).
  const yes = await chat(agent, 'sim');
  assert.match(yes.body.reply, /Pronto/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM families WHERE family_name = 'Novo'").get().n, 1);
});
