// Buggy, the voice assistant page and its JSON endpoints.
import express from 'express';
import { gemini } from '../lib/buggy/gemini.js';
import { handleMessage, confirmPending, cancelPending, newState } from '../lib/buggy/agent.js';
import { getSettings } from '../db/index.js';
import { audit } from '../lib/audit.js';

const router = express.Router();

// Simple per-user limit so a stuck microphone cannot run up API costs.
const hits = new Map();
function rateLimited(userId, max = 30, windowMs = 60000) {
  const now = Date.now();
  const list = (hits.get(userId) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(userId, list);
  return list.length > max;
}

function state(req) {
  req.session.buggy ||= newState();
  return req.session.buggy;
}

/** Plain-text history for the page (tool calls and system notes left out). */
function transcript(s) {
  const out = [];
  for (const c of s.contents) {
    const text = c.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(' ').trim();
    if (!text || text.startsWith('[Nota do sistema]')) continue;
    out.push({ who: c.role === 'model' ? 'buggy' : 'me', text });
  }
  return out.slice(-30);
}

router.get('/', (req, res) => {
  const s = state(req);
  res.render('assistant/index', {
    title: 'Buggy',
    enabled: gemini.enabled(),
    history: transcript(s),
    pending: s.pending.map((p) => ({ summary: p.summary })),
    manifest: true,
  });
});

router.post('/message', async (req, res) => {
  if (!gemini.enabled()) return res.status(503).json({ error: 'Buggy is not configured yet (GEMINI_API_KEY is missing).' });
  if (rateLimited(req.user.id)) return res.status(429).json({ error: 'Muitas mensagens seguidas. Espere um minuto.' });
  const db = req.app.get('db');
  try {
    const result = await handleMessage(db, req.user, state(req), req.body?.text, getSettings(db));
    res.json(result);
  } catch (e) {
    console.error('[buggy]', e);
    res.status(502).json({ error: `Buggy não conseguiu responder agora. (${e.message})` });
  }
});

router.post('/confirm', async (req, res) => {
  const db = req.app.get('db');
  const s = state(req);
  if (!s.pending.length) return res.json({ reply: 'Não há nada esperando confirmação.', pending: [] });
  const result = req.body?.decision === 'yes' ? await confirmPending(db, req.user, s) : cancelPending(s);
  res.json(result);
});

router.post('/reset', (req, res) => {
  req.session.buggy = newState();
  audit(req.app.get('db'), req.user, 'reset', 'buggy');
  res.json({ ok: true });
});

export default router;
