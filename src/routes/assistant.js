// Buggy, the voice assistant page and its JSON endpoints.
import express from 'express';
import { gemini } from '../lib/buggy/gemini.js';
import { handleMessage, confirmPending, cancelPending, newState } from '../lib/buggy/agent.js';
import { getSettings } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { T, langOf } from '../lib/buggy/i18n.js';

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
    const text = c.parts.filter((p) => typeof p.text === 'string' && !p.thought && !p.text.startsWith('[Nota do sistema]')).map((p) => p.text).join(' ').trim();
    if (!text) continue;
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

/**
 * Clients sending `Accept: application/x-ndjson` get progress lines while Buggy
 * works ({"step": "..."}) and then {"result": {...}} or {"error": "..."}.
 * Other clients get one JSON answer.
 */
function responder(req, res) {
  const streaming = (req.get('accept') || '').includes('application/x-ndjson');
  if (streaming) {
    res.status(200).set({
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
  }
  const line = (obj) => res.write(`${JSON.stringify(obj)}\n`);
  return {
    step: streaming ? (text) => line({ step: text }) : () => {},
    done: (result) => (streaming ? res.end(`${JSON.stringify({ result })}\n`) : res.json(result)),
    fail: (status, error) => (streaming ? res.end(`${JSON.stringify({ error })}\n`) : res.status(status).json({ error })),
  };
}

router.post('/message', async (req, res) => {
  const out = responder(req, res);
  const t = T(req.body?.lang || state(req).lang);
  if (!gemini.enabled()) return out.fail(503, t.notConfigured);
  if (rateLimited(req.user.id)) return out.fail(429, t.tooMany);
  const db = req.app.get('db');
  try {
    out.done(await handleMessage(db, req.user, state(req), req.body?.text, getSettings(db), out.step, req.body?.lang));
  } catch (e) {
    console.error('[buggy]', e);
    out.fail(502, e.busy ? t.busy : t.error(e.message));
  }
});

router.post('/confirm', async (req, res) => {
  const db = req.app.get('db');
  const s = state(req);
  if (req.body?.lang) s.lang = langOf(req.body.lang);
  if (!s.pending.length) return res.json({ reply: T(s.lang).nothingPending, pending: [] });
  const result = req.body?.decision === 'yes' ? await confirmPending(db, req.user, s, () => {}) : cancelPending(s);
  res.json(result);
});

router.post('/reset', (req, res) => {
  req.session.buggy = newState();
  audit(req.app.get('db'), req.user, 'reset', 'buggy');
  res.json({ ok: true });
});

export default router;
