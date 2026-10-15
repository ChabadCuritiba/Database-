// Buggy's conversation loop: the model reads data through tools and proposes
// changes; changes run only after the user confirms them.
import { gemini } from './gemini.js';
import { toolsFor, declarations, findTool, ToolError } from './tools.js';
import { toHebrew, formatHebrew, todayISO } from '../hebrew.js';

const MAX_ROUNDS = 8;
const MAX_CONTENTS = 40;

const YES = /^(sim|s|yes|y|confirmo|confirma|confirmar|confirmado|pode|pode sim|ok|okay|isso|claro|beleza|correto|certo|manda|faz)\b/i;
const NO = /^(n[aã]o|no|nope|cancela|cancelar|cancel|para|pare|esquece)\b/i;

export const isYes = (t) => t.trim().length <= 40 && YES.test(t.trim());
export const isNo = (t) => t.trim().length <= 40 && NO.test(t.trim());

export function newState() {
  return { contents: [], pending: [] };
}

function systemPrompt(user, settings) {
  const today = todayISO();
  const h = formatHebrew(toHebrew(today));
  return [
    `You are Buggy, the friendly assistant inside the contact-management system of ${settings.org_name || 'a Chabad house'}.`,
    `You are talking with ${user.name || user.email} (role: ${user.role}). Today is ${today} (${h.en}).`,
    'Reply in the language the user speaks (usually Brazilian Portuguese). Your replies are read aloud: keep them short and natural,',
    'one to three sentences, plain text without markdown, lists or emojis. Say amounts like "cento e oitenta reais" only if natural.',
    'Use the tools to look things up and to make changes. Never invent contacts, ids, emails, dates or amounts.',
    'Before creating a contact, search for it; if a similar contact exists, ask whether to use it. If a search returns several matches, ask which one.',
    'Spell emails exactly as the user said them; if an email or name spelling is unclear, ask.',
    'Changes are not saved until the user confirms: after calling a change tool, tell the user exactly what will be done and ask "Confirma?".',
    'Never say a change was made unless the system told you it was confirmed.',
    'If the user asks for something no tool can do, say so briefly.',
  ].join('\n');
}

function trim(contents) {
  if (contents.length <= MAX_CONTENTS) return;
  contents.splice(0, contents.length - MAX_CONTENTS);
  // The history must start with a plain user message, not a tool result.
  while (contents.length && !(contents[0].role === 'user' && contents[0].parts.some((p) => typeof p.text === 'string'))) contents.shift();
}

const textOf = (content) => content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join(' ').trim();

function note(state, userNote, reply) {
  // Keep the model informed about what the system did, with alternating turns.
  state.contents.push({ role: 'user', parts: [{ text: `[Nota do sistema] ${userNote}` }] });
  state.contents.push({ role: 'model', parts: [{ text: reply }] });
}

export async function confirmPending(db, user, state) {
  const done = [];
  const failed = [];
  for (const p of state.pending) {
    const { tool, error } = findTool(user, p.tool);
    if (error) { failed.push(`${p.summary}: ${error}`); continue; }
    try {
      done.push(tool.execute(db, user, p.args));
    } catch (e) {
      failed.push(`${p.summary}: ${e.message}`);
    }
  }
  state.pending = [];
  const reply = [done.map((d) => d.message).join(' '), failed.length ? `Não consegui: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ') || 'Nada a fazer.';
  note(state, `O usuário confirmou. Resultado: ${JSON.stringify(done.map((d) => ({ message: d.message, family_id: d.family_id })))}${failed.length ? ` Falhas: ${failed.join('; ')}` : ''}`, `Pronto! ${reply}`);
  return { reply: `Pronto! ${reply}`, links: done.filter((d) => d.link).map((d) => ({ href: d.link, label: d.message })), pending: [] };
}

export function cancelPending(state, reason = 'O usuário cancelou') {
  if (!state.pending.length) return { reply: 'Ok.', pending: [] };
  const what = state.pending.map((p) => p.summary).join('; ');
  state.pending = [];
  const reply = 'Ok, cancelado. Nada foi salvo.';
  note(state, `${reason}: ${what}. Nada foi salvo.`, reply);
  return { reply, pending: [] };
}

export async function handleMessage(db, user, state, text, settings = {}) {
  text = String(text || '').trim().slice(0, 2000);
  if (!text) return { reply: 'Não ouvi nada. Pode repetir?', pending: state.pending };

  if (state.pending.length) {
    if (isYes(text)) return confirmPending(db, user, state);
    if (isNo(text)) return cancelPending(state);
    cancelPending(state, 'O usuário mudou de assunto antes de confirmar');
  }

  state.contents.push({ role: 'user', parts: [{ text }] });
  const tools = toolsFor(user);
  const decls = declarations(tools);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    trim(state.contents);
    const content = await gemini.generate({ system: systemPrompt(user, settings), contents: state.contents, tools: decls });
    state.contents.push(content);
    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      return { reply: textOf(content) || 'Ok.', pending: state.pending.map((p) => ({ summary: p.summary })) };
    }
    const responses = calls.map(({ functionCall: fc }) => {
      const { tool, error } = findTool(user, fc.name);
      let response;
      if (error) response = { error };
      else {
        try {
          if (tool.kind === 'read') response = { result: tool.run(db, user, fc.args || {}) };
          else {
            const prepared = tool.prepare(db, user, fc.args || {});
            state.pending.push({ tool: tool.name, args: prepared.args, summary: prepared.summary });
            response = {
              status: 'awaiting_user_confirmation',
              summary: prepared.summary,
              instruction: 'Not saved yet. Tell the user exactly this and ask them to confirm (sim/não).',
            };
          }
        } catch (e) {
          response = { error: e instanceof ToolError ? e.message : `Unexpected error: ${e.message}` };
        }
      }
      return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response } };
    });
    state.contents.push({ role: 'user', parts: responses });
  }
  return { reply: 'Desculpe, me enrolei com esse pedido. Pode dizer de outro jeito?', pending: state.pending.map((p) => ({ summary: p.summary })) };
}
