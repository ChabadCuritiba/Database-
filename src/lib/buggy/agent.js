// Dot's conversation loop: the model reads data through tools and proposes
// changes; changes run only after the user confirms them.
import { gemini } from './gemini.js';
import { toolsFor, declarations, findTool, ToolError } from './tools.js';
import { toHebrew, formatHebrew, todayISO } from '../hebrew.js';
import { T, langOf, LANGUAGE_NAME } from './i18n.js';

const MAX_ROUNDS = 8;
const MAX_CONTENTS = 40;

const YES = /^(sim|s|yes|y|yeah|yep|sure|save it|go ahead|confirmo|confirma|confirmar|confirmado|pode|pode sim|ok|okay|isso|claro|beleza|correto|certo|manda|faz|כן|בטח|אשר|תשמור)(?=$|[\s,.!])/i;
const NO = /^(n[aã]o|no|nope|cancela|cancelar|cancel|stop|para|pare|esquece|לא|בטל|עזוב)(?=$|[\s,.!])/i;

export const isYes = (t) => t.trim().length <= 40 && YES.test(t.trim());
export const isNo = (t) => t.trim().length <= 40 && NO.test(t.trim());

export function newState() {
  return { contents: [], pending: [], lang: 'pt' };
}

function systemPrompt(user, settings, lang) {
  const today = todayISO();
  const h = formatHebrew(toHebrew(today));
  return [
    `You are Dot, the friendly assistant inside the contact-management system of ${settings.org_name || 'a Chabad house'}.`,
    `You are talking with ${user.name || user.email} (role: ${user.role}). Today is ${today} (${h.en}).`,
    `Always reply in ${LANGUAGE_NAME[lang]}, whatever language earlier messages used. Your replies are read aloud: keep them short and natural,`,
    'one to three sentences, plain text without markdown, lists or emojis. Say amounts like "cento e oitenta reais" only if natural.',
    'Use the tools to look things up and to make changes. Never invent contacts, ids, emails, dates or amounts.',
    'To act on an existing contact, search for it first; if a search returns several matches, ask which one. create_contact checks for duplicates itself.',
    'Spell emails exactly as the user said them; if an email or name spelling is unclear, ask.',
    'Every change (new contacts, family members, contact details, donations, Yahrzeits and other occasions) is saved as soon as you call its tool.',
    'Call the tool right away, in any language: never ask the user for permission or confirmation first, and do not ask for details',
    'they did not give when the tool does not need them (for a new contact a name is enough). Afterwards just say what was saved.',
    'Ask only when something required is missing or unclear (which contact, the amount) or when a tool reports a possible duplicate.',
    'Never say a change was made unless a tool result says it was saved.',
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

/**
 * Progress step codes shown while Dot works; the page translates them
 * (thinking, searching, creating...). Keep them short and non-technical.
 */
const STEP_FOR_TOOL = {
  search_contacts: 'searching',
  get_contact: 'reading',
  upcoming_occasions: 'checking_dates',
  list_funds: 'checking_funds',
  create_contact: 'creating_contact',
  add_family_member: 'adding_person',
  update_contact_info: 'updating',
  record_donation: 'recording_donation',
  add_occasion: 'adding_date',
};
export const stepFor = (toolName) => STEP_FOR_TOOL[toolName] || 'working';

export async function confirmPending(db, user, state, onStep = () => {}) {
  onStep('saving');
  const done = [];
  const failed = [];
  for (const p of state.pending) {
    const { tool, error } = findTool(user, p.tool);
    if (error) { failed.push(`${p.summary}: ${error}`); continue; }
    try {
      done.push(tool.execute(db, user, p.args, state.lang));
    } catch (e) {
      failed.push(`${p.summary}: ${e.message}`);
    }
  }
  state.pending = [];
  const t = T(state.lang);
  const reply = [done.map((d) => d.message).join(' '), failed.length ? `${t.failed}: ${failed.join('; ')}.` : ''].filter(Boolean).join(' ') || t.nothing;
  note(state, `O usuário confirmou. Resultado: ${JSON.stringify(done.map((d) => ({ message: d.message, family_id: d.family_id })))}${failed.length ? ` Falhas: ${failed.join('; ')}` : ''}`, `${t.done} ${reply}`);
  return { reply: `${t.done} ${reply}`, links: done.filter((d) => d.link).map((d) => ({ href: d.link, label: d.message })), pending: [] };
}

export function cancelPending(state, reason = 'O usuário cancelou') {
  if (!state.pending.length) return { reply: 'OK.', pending: [] };
  const what = state.pending.map((p) => p.summary).join('; ');
  state.pending = [];
  const reply = T(state.lang).cancelled;
  note(state, `${reason}: ${what}. Nada foi salvo.`, reply);
  return { reply, pending: [] };
}

export async function handleMessage(db, user, state, text, settings = {}, onStep = () => {}, lang) {
  if (lang) state.lang = langOf(lang);
  state.lang ||= 'pt';
  text = String(text || '').trim().slice(0, 2000);
  if (!text) return { reply: T(state.lang).empty, pending: state.pending };

  if (state.pending.length) {
    if (isYes(text)) return confirmPending(db, user, state, onStep);
    if (isNo(text)) return cancelPending(state);
    cancelPending(state, 'O usuário mudou de assunto antes de confirmar');
  }

  const before = state.contents.length;
  const pendingBefore = state.pending.length;
  state.contents.push({ role: 'user', parts: [{ text }] });
  try {
    return await converse(db, user, state, settings, onStep, text);
  } catch (e) {
    // Forget the failed turn so the conversation stays valid for the next try.
    state.contents.splice(before);
    state.pending.splice(pendingBefore);
    throw e;
  }
}

// Requests to change something ("add", "adiciona", "תוסיף"...). Used to catch a model that asks
// permission instead of calling the tool, which happens most often in English.
const CHANGE_REQUEST = /\b(add|create|new|save|register|record|put|update|change|set|log|gave|donated|paid)\b|adicion|acrescent|\bcri[ae]\b|cadastr|registr|\bsalv|\bnov[oa]\b|atualiz|mud[ae]|troc[ae]|alter|\bdeu\b|doou|pagou|תוסיף|הוסף|להוסיף|תיצור|צור|תשמור|תרשום|חדש|תעדכן|עדכן|תשנה|שנה|תרם|נתן|שילם/i;
const NUDGE = '[Nota do sistema] Do not ask for permission or confirmation: changes are saved as soon as you call the tool. '
  + 'If the user asked for a change and gave what the tool needs, call the tool now with the details given. Otherwise answer the user normally.';

async function converse(db, user, state, settings, onStep, text = '') {
  const tools = toolsFor(user);
  const decls = declarations(tools);
  let nudged = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    trim(state.contents);
    onStep('thinking');
    const content = await gemini.generate({ system: systemPrompt(user, settings, state.lang), contents: state.contents, tools: decls });
    state.contents.push(content);
    const calls = content.parts.filter((p) => p.functionCall);
    if (!calls.length) {
      if (round === 0 && !nudged && CHANGE_REQUEST.test(text) && textOf(content).includes('?') && tools.some((t) => t.autoSave)) {
        // It asked instead of saving: drop the question and tell it to save.
        nudged = true;
        state.contents.pop();
        state.contents.at(-1).parts.push({ text: NUDGE });
        round--;
        continue;
      }
      return { reply: textOf(content) || 'Ok.', pending: state.pending.map((p) => ({ summary: p.summary })) };
    }
    let proposed = 0;
    let needsModel = false;
    const saved = [];
    const responses = calls.map(({ functionCall: fc }) => {
      onStep(stepFor(fc.name));
      const { tool, error } = findTool(user, fc.name);
      let response;
      if (error) response = { error };
      else {
        try {
          if (tool.kind === 'read') response = { result: tool.run(db, user, fc.args || {}) };
          else {
            const prepared = tool.prepare(db, user, fc.args || {}, state.lang);
            if (prepared.warning) {
              response = { status: 'not_proposed', warning: prepared.warning };
            } else if (tool.autoSave) {
              const result = tool.execute(db, user, prepared.args, state.lang);
              saved.push(result);
              response = { status: 'saved', message: result.message, ...(result.family_id ? { family_id: result.family_id } : {}) };
            } else {
              state.pending.push({ tool: tool.name, args: prepared.args, summary: prepared.summary });
              proposed++;
              response = {
                status: 'awaiting_user_confirmation',
                summary: prepared.summary,
                instruction: 'Not saved yet. The user is being asked to confirm (sim/não).',
              };
            }
          }
        } catch (e) {
          response = { error: e instanceof ToolError ? e.message : `Unexpected error: ${e.message}` };
        }
      }
      if (!['awaiting_user_confirmation', 'saved'].includes(response.status)) needsModel = true;
      return { functionResponse: { name: fc.name, ...(fc.id ? { id: fc.id } : {}), response } };
    });
    state.contents.push({ role: 'user', parts: responses });
    if ((proposed || saved.length) && !needsModel) {
      // Every call was saved or is ready for confirmation: answer directly
      // instead of waiting for the model to phrase it (saves a full round trip).
      const t = T(state.lang);
      const parts = [];
      if (saved.length) parts.push(`${t.done} ${saved.map((r) => r.message).join(' ')}`);
      if (proposed) parts.push(`${state.pending.map((p) => p.summary).join('. ')}. ${t.confirm}`);
      const reply = parts.join(' ');
      state.contents.push({ role: 'model', parts: [{ text: reply }] });
      return {
        reply,
        links: saved.filter((r) => r.link).map((r) => ({ href: r.link, label: r.message })),
        pending: state.pending.map((p) => ({ summary: p.summary })),
      };
    }
  }
  return { reply: T(state.lang).lost, pending: state.pending.map((p) => ({ summary: p.summary })) };
}
