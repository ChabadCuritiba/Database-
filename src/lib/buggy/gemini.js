// Google Gemini (generateContent + function calling) over its REST API.
// Model replies are kept exactly as received - they can carry thought
// signatures that must be sent back unchanged on the next request.
import { config } from '../../config.js';

let cachedModels = null;
// Models that recently answered "busy" are skipped for a while.
const cooldown = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;
// Models that rejected our thinking setting; they get requests without it.
const noThinkingConfig = new Set();

/**
 * Keep "thinking" to a minimum: Buggy's tasks are simple and speed matters.
 * Gemini 2.x takes a token budget, Gemini 3+ a level.
 */
export function thinkingConfigFor(model) {
  const v = Number((model.match(/^gemini-([\d.]+)-/) || [])[1]);
  if (!v) return null;
  return v < 3 ? { thinkingBudget: 0 } : { thinkingLevel: 'low' };
}

async function call(path, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const res = await fetch(`${config.gemini.baseUrl}/${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Gemini: ${msg}`), { status: res.status });
  }
  return data;
}

/** Ranks model ids like "gemini-3.6-flash": stable models newest first, then previews (they are often overloaded). */
export function rankModels(names) {
  return names
    .map((n) => n.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|audio|live|embedding|thinking-exp/.test(n))
    .map((n) => ({
      n,
      version: Number(n.match(/^gemini-([\d.]+)-/)[1].split('.').slice(0, 2).join('.')),
      preview: /preview|exp/.test(n) ? 1 : 0,
      dated: /-\d{2,}$|-\d{4}$/.test(n) ? 1 : 0,
    }))
    .sort((a, b) => a.preview - b.preview || b.version - a.version || a.dated - b.dated || a.n.length - b.n.length)
    .map((c) => c.n);
}

export function pickModel(names) {
  return rankModels(names)[0] || null;
}

/** Models to try in order: the configured one (if any), then the best available Flash models. */
export async function modelChain() {
  if (!cachedModels) {
    try {
      const names = [];
      let pageToken = '';
      do {
        const data = await call(`models?pageSize=200${pageToken ? `&pageToken=${pageToken}` : ''}`);
        for (const m of data.models || []) {
          if ((m.supportedGenerationMethods || []).includes('generateContent')) names.push(m.name);
        }
        pageToken = data.nextPageToken || '';
      } while (pageToken);
      cachedModels = rankModels(names).slice(0, 3);
    } catch {
      cachedModels = [];
    }
    if (!cachedModels.length) cachedModels = ['gemini-2.5-flash'];
  }
  const chain = [...new Set([config.gemini.model, ...cachedModels].filter(Boolean))];
  const now = Date.now();
  const ready = chain.filter((m) => !(cooldown.get(m) > now));
  return ready.length ? ready : chain;
}

export async function resolveModel() {
  return (await modelChain())[0];
}

/** Google is busy / rate limited: worth retrying or trying another model. */
/** No answer in time, or the connection failed: try the next model rather than waiting again. */
const isTimeout = (e) => ['TimeoutError', 'AbortError'].includes(e.name) || /fetch failed|ECONN|ETIMEDOUT|socket/i.test(`${e.message} ${e.cause?.code || ''}`);
const isBusy = (e) => isTimeout(e) || [429, 500, 502, 503, 504].includes(e.status) || /overload|high demand|unavailable|try again/i.test(e.message);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tests replace this to simulate the model. */
export const gemini = {
  enabled: () => !!config.gemini.apiKey,
  retryDelays: [800, 2000],
  requestTimeoutMs: 20000, // one Gemini call
  totalBudgetMs: 45000, // everything for one reply, across retries and models
  /**
   * Returns the model's content object: { role: 'model', parts: [...] }.
   * Busy answers are retried, then the next model in the chain is tried.
   */
  async generate({ system, contents, tools }) {
    const bodyFor = (model) => {
      const thinking = noThinkingConfig.has(model) ? null : thinkingConfigFor(model);
      return {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.2, ...(thinking ? { thinkingConfig: thinking } : {}) },
      };
    };
    let data;
    let lastError;
    const deadline = Date.now() + this.totalBudgetMs;
    for (const model of await modelChain()) {
      for (let attempt = 0; attempt <= this.retryDelays.length && !data; attempt++) {
        const started = Date.now();
        const left = deadline - started;
        if (left < 2000) break;
        try {
          data = await call(`models/${encodeURIComponent(model)}:generateContent`, {
            method: 'POST', body: bodyFor(model), timeoutMs: Math.min(this.requestTimeoutMs, left),
          });
          if (process.env.BUGGY_DEBUG) console.log(`[buggy] ${model} answered in ${Date.now() - started} ms`);
        } catch (e) {
          lastError = e;
          if (e.status === 400 && /thinking/i.test(e.message) && !noThinkingConfig.has(model)) {
            noThinkingConfig.add(model); // this model does not accept the setting: retry without it
            attempt--;
            continue;
          }
          if (process.env.BUGGY_DEBUG) console.log(`[buggy] ${model} failed after ${Date.now() - started} ms: ${e.name} ${e.message}`);
          if (e.status === 404) break; // this model is not available: try the next one
          if (!isBusy(e)) throw e;
          if (isTimeout(e)) break; // a model that does not answer gets no second wait
          if (attempt < this.retryDelays.length) await sleep(this.retryDelays[attempt]);
        }
      }
      if (data) break;
      if (lastError && isBusy(lastError)) cooldown.set(model, Date.now() + COOLDOWN_MS);
      if (deadline - Date.now() < 2000) break;
    }
    if (!data) {
      throw Object.assign(new Error(isBusy(lastError || {}) ? 'Os servidores do Google estão ocupados agora. Tente de novo em um minuto.' : lastError?.message || 'Gemini failed'), { busy: true });
    }
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.length) {
      const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'empty response';
      throw new Error(`Gemini returned no answer (${reason})`);
    }
    return { ...candidate.content, role: 'model' };
  },
};
