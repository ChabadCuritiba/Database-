// Buggy's fixed texts (confirmations, results, errors) in the languages of the page.
// Messages to the model stay in English; these are what the user reads or hears.
import { formatMoney } from '../format.js';

export const LANGS = { 'pt-BR': 'pt', 'en-US': 'en', 'he-IL': 'he', pt: 'pt', en: 'en', he: 'he' };
export const langOf = (v) => LANGS[v] || 'pt';
export const LANGUAGE_NAME = { pt: 'Brazilian Portuguese', en: 'English', he: 'Hebrew' };

const RELATION = {
  pt: { primary: 'titular', spouse: 'cônjuge', child: 'filho(a)', parent: 'pai/mãe', other: 'outro' },
  en: { primary: 'main contact', spouse: 'spouse', child: 'child', parent: 'parent', other: 'other' },
  he: { primary: 'איש קשר ראשי', spouse: 'בן/בת זוג', child: 'ילד/ה', parent: 'הורה', other: 'אחר' },
};
const METHOD = {
  pt: { cash: 'dinheiro', check: 'cheque', pix: 'PIX', card: 'cartão', transfer: 'transferência', other: 'outro' },
  en: { cash: 'cash', check: 'check', pix: 'PIX', card: 'card', transfer: 'bank transfer', other: 'other' },
  he: { cash: 'מזומן', check: 'צ׳ק', pix: 'PIX', card: 'כרטיס אשראי', transfer: 'העברה בנקאית', other: 'אחר' },
};
const OCCASION = {
  pt: { yahrzeit: 'Yahrzeit', birthday: 'aniversário', anniversary: 'aniversário de casamento', bar_mitzvah: 'Bar Mitzvá', bat_mitzvah: 'Bat Mitzvá', other: 'data' },
  en: { yahrzeit: 'Yahrzeit', birthday: 'birthday', anniversary: 'anniversary', bar_mitzvah: 'Bar Mitzvah', bat_mitzvah: 'Bat Mitzvah', other: 'occasion' },
  he: { yahrzeit: 'יארצייט', birthday: 'יום הולדת', anniversary: 'יום נישואין', bar_mitzvah: 'בר מצווה', bat_mitzvah: 'בת מצווה', other: 'אירוע' },
};
const FIELD = {
  pt: { email: 'email', mobile: 'celular', phone: 'telefone', street: 'rua', number: 'número', complement: 'complemento', neighborhood: 'bairro', city: 'cidade', state: 'estado', cep: 'CEP' },
  en: { email: 'email', mobile: 'mobile', phone: 'phone', street: 'street', number: 'number', complement: 'complement', neighborhood: 'neighborhood', city: 'city', state: 'state', cep: 'postal code' },
  he: { email: 'אימייל', mobile: 'נייד', phone: 'טלפון', street: 'רחוב', number: 'מספר', complement: 'תוספת', neighborhood: 'שכונה', city: 'עיר', state: 'מדינה', cep: 'מיקוד' },
};

const TEXT = {
  pt: {
    createContact: (v) => [`Criar contato "${v.family_name}"`, v.first_name && `titular ${v.first_name}`, v.email && `email ${v.email}`,
      v.mobile && `celular ${v.mobile}`, v.city && `cidade ${v.city}`,
      ...v.members.map((m) => `com ${m.first_name}${m.last_name ? ` ${m.last_name}` : ''} (${RELATION.pt[m.relation]})`)].filter(Boolean).join(', '),
    addMember: (v, fam) => `Adicionar ${v.first_name} ${v.last_name} (${RELATION.pt[v.relation]}) à família ${fam}${v.birth_date ? `, nascido(a) em ${v.birth_date}` : ''}`,
    update: (fam, ch) => `Atualizar ${fam}: ${Object.entries(ch).map(([k, val]) => `${FIELD.pt[k] || k} ${val}`).join(', ')}`,
    donation: (v, donor, fund) => `Registrar doação de ${formatMoney(v.amount)} de ${donor || 'doador anônimo'}, fundo ${fund}, via ${METHOD.pt[v.method]}, em ${v.date}`,
    occasion: (v, fam, h, next) => `Adicionar ${OCCASION.pt[v.type]} de ${v.name} (${v.gregorian_date} = ${h}) à família ${fam}${next ? `. Próxima data: ${next.date} (${next.hebrew})` : ''}`,
    created: (n) => `Contato "${n}" criado.`,
    memberAdded: (n) => `${n} adicionado(a).`,
    updated: 'Contato atualizado.',
    donationSaved: (a) => `Doação de ${formatMoney(a)} registrada.`,
    occasionAdded: (type, n) => `${OCCASION.pt[type]} de ${n} adicionado(a).`,
    confirm: 'Confirma?',
    done: 'Pronto!',
    failed: 'Não consegui',
    nothing: 'Nada a fazer.',
    cancelled: 'Ok, cancelado. Nada foi salvo.',
    empty: 'Não ouvi nada. Pode repetir?',
    lost: 'Desculpe, me enrolei com esse pedido. Pode dizer de outro jeito?',
    nothingPending: 'Não há nada esperando confirmação.',
    tooMany: 'Muitas mensagens seguidas. Espere um minuto.',
    busy: 'Os servidores do Google estão ocupados agora. Tente de novo em um minuto.',
    error: (m) => `Buggy não conseguiu responder agora. (${m})`,
    notConfigured: 'Buggy ainda não está configurado (falta a GEMINI_API_KEY).',
  },
  en: {
    createContact: (v) => [`Create contact "${v.family_name}"`, v.first_name && `main contact ${v.first_name}`, v.email && `email ${v.email}`,
      v.mobile && `mobile ${v.mobile}`, v.city && `city ${v.city}`,
      ...v.members.map((m) => `with ${m.first_name}${m.last_name ? ` ${m.last_name}` : ''} (${RELATION.en[m.relation]})`)].filter(Boolean).join(', '),
    addMember: (v, fam) => `Add ${v.first_name} ${v.last_name} (${RELATION.en[v.relation]}) to the ${fam} family${v.birth_date ? `, born ${v.birth_date}` : ''}`,
    update: (fam, ch) => `Update ${fam}: ${Object.entries(ch).map(([k, val]) => `${FIELD.en[k] || k} ${val}`).join(', ')}`,
    donation: (v, donor, fund) => `Record a donation of ${formatMoney(v.amount)} from ${donor || 'an anonymous donor'}, fund ${fund}, by ${METHOD.en[v.method]}, on ${v.date}`,
    occasion: (v, fam, h, next) => `Add the ${OCCASION.en[v.type]} of ${v.name} (${v.gregorian_date} = ${h}) to the ${fam} family${next ? `. Next date: ${next.date} (${next.hebrew})` : ''}`,
    created: (n) => `Contact "${n}" created.`,
    memberAdded: (n) => `${n} added.`,
    updated: 'Contact updated.',
    donationSaved: (a) => `Donation of ${formatMoney(a)} recorded.`,
    occasionAdded: (type, n) => `${OCCASION.en[type][0].toUpperCase()}${OCCASION.en[type].slice(1)} of ${n} added.`,
    confirm: 'Shall I save it?',
    done: 'Done!',
    failed: "I couldn't",
    nothing: 'Nothing to do.',
    cancelled: 'OK, cancelled. Nothing was saved.',
    empty: "I didn't hear anything. Could you repeat?",
    lost: "Sorry, I got confused by that request. Could you say it another way?",
    nothingPending: 'Nothing is waiting for confirmation.',
    tooMany: 'Too many messages in a row. Please wait a minute.',
    busy: "Google's servers are busy right now. Please try again in a minute.",
    error: (m) => `Buggy couldn't answer right now. (${m})`,
    notConfigured: 'Buggy is not configured yet (GEMINI_API_KEY is missing).',
  },
  he: {
    createContact: (v) => [`ליצור איש קשר "${v.family_name}"`, v.first_name && `איש קשר ראשי ${v.first_name}`, v.email && `אימייל ${v.email}`,
      v.mobile && `נייד ${v.mobile}`, v.city && `עיר ${v.city}`,
      ...v.members.map((m) => `עם ${m.first_name}${m.last_name ? ` ${m.last_name}` : ''} (${RELATION.he[m.relation]})`)].filter(Boolean).join(', '),
    addMember: (v, fam) => `להוסיף את ${v.first_name} ${v.last_name} (${RELATION.he[v.relation]}) למשפחת ${fam}${v.birth_date ? `, נולד/ה ב-${v.birth_date}` : ''}`,
    update: (fam, ch) => `לעדכן את ${fam}: ${Object.entries(ch).map(([k, val]) => `${FIELD.he[k] || k} ${val}`).join(', ')}`,
    donation: (v, donor, fund) => `לרשום תרומה של ${formatMoney(v.amount)} מ${donor ? `-${donor}` : 'תורם אנונימי'}, קרן ${fund}, ב${METHOD.he[v.method]}, בתאריך ${v.date}`,
    occasion: (v, fam, h, next) => `להוסיף ${OCCASION.he[v.type]} של ${v.name} (${v.gregorian_date} = ${h}) למשפחת ${fam}${next ? `. התאריך הבא: ${next.date} (${next.hebrew})` : ''}`,
    created: (n) => `איש הקשר "${n}" נוצר.`,
    memberAdded: (n) => `${n} נוסף/ה.`,
    updated: 'איש הקשר עודכן.',
    donationSaved: (a) => `תרומה של ${formatMoney(a)} נרשמה.`,
    occasionAdded: (type, n) => `${OCCASION.he[type]} של ${n} נוסף.`,
    confirm: 'לשמור?',
    done: 'בוצע!',
    failed: 'לא הצלחתי',
    nothing: 'אין מה לעשות.',
    cancelled: 'בסדר, בוטל. שום דבר לא נשמר.',
    empty: 'לא שמעתי כלום. אפשר לחזור?',
    lost: 'סליחה, התבלבלתי עם הבקשה. אפשר לנסח אחרת?',
    nothingPending: 'אין שום דבר שממתין לאישור.',
    tooMany: 'יותר מדי הודעות ברצף. המתן דקה.',
    busy: 'השרתים של גוגל עמוסים כרגע. נסה שוב בעוד דקה.',
    error: (m) => `באגי לא הצליח לענות כרגע. (${m})`,
    notConfigured: 'באגי עדיין לא מוגדר (חסר GEMINI_API_KEY).',
  },
};

/** Text for the given language (falls back to Portuguese). */
export function T(lang) {
  return TEXT[langOf(lang)] || TEXT.pt;
}
