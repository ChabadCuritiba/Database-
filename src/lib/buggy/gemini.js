// Google Gemini (generateContent + function calling) over its REST API.
// Model replies are kept exactly as received - they can carry thought
// signatures that must be sent back unchanged on the next request.
import { config } from '../../config.js';

let cachedModel = null;

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${config.gemini.baseUrl}/${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': config.gemini.apiKey },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw Object.assign(new Error(`Gemini: ${msg}`), { status: res.status });
  }
  return data;
}

/** Ranks model ids like "gemini-3.6-flash" so the newest stable Flash comes first. */
export function pickModel(names) {
  const candidates = names
    .map((n) => n.replace(/^models\//, ''))
    .filter((n) => /^gemini-[\d.]+-flash/.test(n) && !/lite|image|tts|audio|live|embedding|thinking-exp/.test(n))
    .map((n) => ({
      n,
      version: Number(n.match(/^gemini-([\d.]+)-/)[1].split('.').slice(0, 2).join('.')),
      preview: /preview|exp/.test(n) ? 1 : 0,
      dated: /-\d{2,}$|-\d{4}$/.test(n) ? 1 : 0,
    }))
    .sort((a, b) => b.version - a.version || a.preview - b.preview || a.dated - b.dated || a.n.length - b.n.length);
  return candidates[0]?.n || null;
}

export async function resolveModel() {
  if (config.gemini.model) return config.gemini.model;
  if (cachedModel) return cachedModel;
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
    cachedModel = pickModel(names) || 'gemini-2.5-flash';
  } catch {
    cachedModel = 'gemini-2.5-flash';
  }
  return cachedModel;
}

/** Tests replace this to simulate the model. */
export const gemini = {
  enabled: () => !!config.gemini.apiKey,
  /** Returns the model's content object: { role: 'model', parts: [...] }. */
  async generate({ system, contents, tools }) {
    const model = await resolveModel();
    const data = await call(`models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents,
        tools: [{ functionDeclarations: tools }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        generationConfig: { temperature: 0.2 },
      },
    });
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts?.length) {
      const reason = candidate?.finishReason || data.promptFeedback?.blockReason || 'empty response';
      throw new Error(`Gemini returned no answer (${reason})`);
    }
    return { ...candidate.content, role: 'model' };
  },
};
