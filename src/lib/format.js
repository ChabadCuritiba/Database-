import { config } from '../config.js';

const money = new Intl.NumberFormat(config.locale, { style: 'currency', currency: config.currency });

/** Format an integer amount of cents as currency. */
export function formatMoney(cents) {
  return money.format((Number(cents) || 0) / 100);
}

/** Parse user input like "1.234,56", "1,234.56" or "50" into integer cents. */
export function parseMoney(input) {
  if (typeof input === 'number') return Math.round(input * 100);
  let s = String(input ?? '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal separator.
    const dec = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    s = s.split(dec === ',' ? '.' : ',').join('').replace(dec, '.');
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = s.split(sep);
    // "1.000" or "1.000.000" are thousands; "12,5" or "12.50" are decimals.
    s = parts.length > 2 || parts[1].length === 3 ? parts.join('') : parts.join('.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Simple {{placeholder}} template merge. Unknown keys become empty strings. */
export function merge(template, data) {
  return String(template ?? '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, k) => (data[k] ?? '').toString());
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Plain text with blank-line paragraphs -> simple HTML. */
export function textToHtml(text) {
  return String(text ?? '')
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

export function formatAddress(f) {
  const line1 = [f.street, f.number].filter(Boolean).join(', ') + (f.complement ? ` - ${f.complement}` : '');
  const line2 = [f.neighborhood, [f.city, f.state].filter(Boolean).join('/')].filter(Boolean).join(' - ');
  const line3 = f.cep ? `CEP ${formatCep(f.cep)}` : '';
  return [line1, line2, line3].filter((l) => l.trim());
}

export function formatCep(cep) {
  const d = String(cep || '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : cep;
}

export function salutationOf(f) {
  return f.salutation || `Família ${f.family_name}`;
}

/** Labels for a family member's place in the family (people.relation). */
export const RELATION_LABELS = {
  primary: 'Main contact',
  spouse: 'Spouse',
  child: 'Child',
  parent: 'Parent',
  other: 'Other',
};

/** Suggestions for an occasion's relationship field (free text, so others can be typed). */
export const RELATIONSHIP_SUGGESTIONS = ['Father', 'Mother', 'Husband', 'Wife', 'Son', 'Daughter', 'Brother', 'Sister',
  'Grandfather', 'Grandmother', 'Father-in-law', 'Mother-in-law', 'Uncle', 'Aunt', 'Friend', 'Self'];
