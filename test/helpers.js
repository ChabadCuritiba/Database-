// Test helpers: in-memory database, app instance and logged-in agents per role.
process.env.DEV_LOGIN = '1';
process.env.NODE_ENV = 'test';
process.env.BACKUP_DIR = process.env.BACKUP_DIR || `/tmp/cp-test-backups-${process.pid}`;

const { openDb } = await import('../src/db/index.js');
const { createApp } = await import('../src/app.js');
const { providers } = await import('../src/lib/messaging.js');
const request = (await import('supertest')).default;

export const outbox = [];
for (const ch of ['email', 'sms', 'call']) {
  providers[ch] = async (msg) => { outbox.push({ channel: ch, ...msg }); return { status: 'sent' }; };
}

export function setup() {
  const db = openDb(':memory:');
  const app = createApp(db);
  return { db, app };
}

export function csrfFrom(html) {
  const m = /name="_csrf" value="([^"]+)"/.exec(html);
  if (!m) throw new Error('No CSRF token in page');
  return m[1];
}

/** Returns a supertest agent logged in with the given role, with a postForm helper. */
export async function login(app, role = 'admin', email = `${role}@example.org`) {
  const agent = request.agent(app);
  const page = await agent.get('/login');
  const res = await agent.post('/auth/dev').type('form').send({ _csrf: csrfFrom(page.text), email, role });
  if (res.status !== 302) throw new Error(`login failed: ${res.status}`);
  // The session is regenerated on login, so fetch a fresh token.
  const home = await agent.get('/');
  const token = csrfFrom(home.text);
  agent.postForm = (url, data = {}) => agent.post(url).type('form').send({ _csrf: token, ...data });
  return agent;
}

export function createFamily(db, values = {}) {
  const v = { family_name: 'Cohen', email: 'cohen@example.org', mobile: '41999990000', street: 'Rua XV', number: '100', city: 'Curitiba', state: 'PR', cep: '80020000', ...values };
  const cols = Object.keys(v);
  return Number(db.prepare(`INSERT INTO families (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...Object.values(v)).lastInsertRowid);
}

/** supertest parser that collects a binary response body into a Buffer. */
export function binary(res, cb) {
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
}
