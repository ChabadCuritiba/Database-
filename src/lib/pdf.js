// Printable PDF output: receipts, year-end statements, letters, labels, envelopes.
import { createRequire } from 'node:module';
import PDFDocument from 'pdfkit';
import { formatAddress, formatMoney, salutationOf } from './format.js';
import { formatGregorian } from './hebrew.js';
import { config } from '../config.js';

const require = createRequire(import.meta.url);
const HEBREW_FONT = require.resolve('@fontsource/noto-sans-hebrew/files/noto-sans-hebrew-hebrew-400-normal.woff');
const HEBREW_RE = /[֐-׿]/;

const MM = 72 / 25.4;

// Receipts and letters are printed in Portuguese.
const METHOD_PT = { cash: 'Dinheiro', check: 'Cheque', pix: 'PIX', card: 'Cartão', transfer: 'Transferência bancária', online: 'Online', other: 'Outro' };

/** Label sheet layouts (dimensions in mm). */
export const LABEL_LAYOUTS = {
  'letter-3x10': { name: 'Letter 3×10 (Avery 5160 / Pimaco 6180)', size: 'LETTER', cols: 3, rows: 10, w: 66.7, h: 25.4, top: 12.7, left: 4.8, gapX: 3.2, gapY: 0 },
  'a4-3x7': { name: 'A4 3×7 (Pimaco A4356-like)', size: 'A4', cols: 3, rows: 7, w: 63.5, h: 38.1, top: 15.15, left: 7.2, gapX: 2.5, gapY: 0 },
  'a4-2x7': { name: 'A4 2×7 (99.1 × 38.1 mm)', size: 'A4', cols: 2, rows: 7, w: 99.1, h: 38.1, top: 15.15, left: 4.65, gapX: 2.5, gapY: 0 },
};

export const ENVELOPE_SIZES = {
  dl: { name: 'DL (110 × 220 mm)', size: [220 * MM, 110 * MM] },
  c5: { name: 'C5 (162 × 229 mm)', size: [229 * MM, 162 * MM] },
  no10: { name: '#10 (4.125 × 9.5 in)', size: [9.5 * 72, 4.125 * 72] },
};

function newDoc(opts = {}) {
  const doc = new PDFDocument({ size: 'A4', margin: 56, ...opts, info: { Producer: 'Community Platform' } });
  doc.registerFont('Hebrew', HEBREW_FONT);
  return doc;
}

function toBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** Writes text, switching to the Hebrew font for runs containing Hebrew letters. */
function mixedText(doc, text, opts = {}) {
  const parts = String(text).split(/([֐-׿][֐-׿\s"'״׳]*[֐-׿]|[֐-׿])/);
  const segs = parts.filter((p) => p !== '');
  segs.forEach((seg, i) => {
    const he = HEBREW_RE.test(seg);
    doc.font(he ? 'Hebrew' : opts.font || 'Helvetica');
    doc.text(seg, { ...opts, continued: i < segs.length - 1, ...(he ? { features: ['rtla'] } : {}) });
  });
  doc.font(opts.font || 'Helvetica');
}

function letterhead(doc, s) {
  doc.font('Helvetica-Bold').fontSize(16).text(s.org_name || '', { align: 'center' });
  doc.font('Helvetica').fontSize(9).fillColor('#444');
  const sub = [s.org_address, s.org_phone, s.org_email].filter(Boolean).join('  ·  ');
  if (sub) doc.text(sub, { align: 'center' });
  if (s.org_tax_id) doc.text(`CNPJ: ${s.org_tax_id}`, { align: 'center' });
  doc.fillColor('black').moveDown(0.5);
  doc.moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).strokeColor('#999').stroke();
  doc.moveDown(1.5).fontSize(11);
}

function addressBlock(doc, family) {
  doc.font('Helvetica').fontSize(11).text(salutationOf(family));
  for (const line of formatAddress(family)) doc.text(line);
  doc.moveDown(1.5);
}

function signature(doc, s) {
  doc.moveDown(2);
  if (s.signature_name) doc.text(s.signature_name);
  if (s.signature_title) doc.fillColor('#444').text(s.signature_title).fillColor('black');
}

function drawReceipt(doc, s, { family, payment, splits }) {
  letterhead(doc, s);
  doc.font('Helvetica-Bold').fontSize(14).text(`Recibo de Doação nº ${payment.receipt_number ?? payment.id}`);
  doc.font('Helvetica').fontSize(11).moveDown(0.5);
  doc.text(`Data: ${formatGregorian(payment.date, config.locale)}`);
  doc.moveDown();
  if (family) {
    addressBlock(doc, family);
    if (family.tax_id) doc.text(`CPF/CNPJ: ${family.tax_id}`).moveDown();
  } else {
    doc.text('Doador anônimo').moveDown();
  }
  doc.font('Helvetica-Bold').text(`Valor recebido: ${formatMoney(payment.amount)}`);
  doc.font('Helvetica').text(`Forma de pagamento: ${METHOD_PT[payment.method] || payment.method}${payment.reference ? ` (${payment.reference})` : ''}`);
  if (splits?.length) {
    doc.moveDown(0.5).text('Destinação:');
    for (const sp of splits) doc.text(`   • ${sp.fund_name}: ${formatMoney(sp.amount)}`);
  }
  doc.moveDown(2).fontSize(9).fillColor('#444').text(s.receipt_footer || '').fillColor('black').fontSize(11);
  signature(doc, s);
}

export async function receiptsPdf(settings, receipts) {
  const doc = newDoc();
  receipts.forEach((r, i) => {
    if (i) doc.addPage();
    drawReceipt(doc, settings, r);
  });
  return toBuffer(doc);
}

export async function yearEndStatementsPdf(settings, statements, year) {
  const doc = newDoc();
  statements.forEach(({ family, payments }, i) => {
    if (i) doc.addPage();
    letterhead(doc, settings);
    doc.font('Helvetica-Bold').fontSize(14).text(`Declaração Anual de Doações ${year}`);
    doc.moveDown();
    addressBlock(doc, family);
    if (family.tax_id) doc.text(`CPF/CNPJ: ${family.tax_id}`).moveDown();
    const x = doc.page.margins.left;
    const cols = [x, x + 80, x + 150, x + 330];
    const row = (cells, bold) => {
      const y = doc.y;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10);
      cells.forEach((c, j) => doc.text(c, cols[j], y, { width: j === 3 ? 120 : cols[j + 1] - cols[j] - 6, align: j === 3 ? 'right' : 'left' }));
      doc.moveDown(0.3);
    };
    row(['Recibo', 'Data', 'Fundo', 'Valor'], true);
    let total = 0;
    for (const p of payments) {
      total += p.amount;
      row([String(p.receipt_number ?? ''), p.date.split('-').reverse().join('/'), p.funds || '', formatMoney(p.amount)]);
      if (doc.y > doc.page.height - 120) doc.addPage();
    }
    doc.moveDown(0.5);
    row(['', '', 'Total', formatMoney(total)], true);
    doc.x = x;
    doc.moveDown(2).fontSize(9).fillColor('#444').text(settings.receipt_footer || '', x).fillColor('black').fontSize(11);
    signature(doc, settings);
  });
  return toBuffer(doc);
}

/** letters: [{ family, body, hebrewLine? }] -- body is already merged plain text. */
export async function lettersPdf(settings, letters, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const doc = newDoc();
  letters.forEach((l, i) => {
    if (i) doc.addPage();
    letterhead(doc, settings);
    doc.text(formatGregorian(date, config.locale), { align: 'right' });
    // Each part on its own line: pdfkit cannot right-align runs that switch fonts.
    for (const part of String(l.hebrewLine || '').split('  ·  ').filter(Boolean)) {
      const he = HEBREW_RE.test(part);
      doc.font(he ? 'Hebrew' : 'Helvetica').text(part, { align: 'right', ...(he ? { features: ['rtla'] } : {}) });
    }
    doc.font('Helvetica');
    doc.moveDown();
    addressBlock(doc, l.family);
    for (const para of String(l.body).split(/\n{2,}/)) {
      mixedText(doc, para, { align: 'left', lineGap: 2 });
      doc.moveDown(0.8);
    }
    signature(doc, settings);
  });
  return toBuffer(doc);
}

export async function labelsPdf(families, layoutKey = 'letter-3x10', { startAt = 1 } = {}) {
  const L = LABEL_LAYOUTS[layoutKey] || LABEL_LAYOUTS['letter-3x10'];
  const doc = newDoc({ size: L.size, margin: 0, autoFirstPage: true });
  const perPage = L.cols * L.rows;
  let slot = Math.max(0, startAt - 1) % perPage;
  for (const f of families) {
    if (slot === perPage) { doc.addPage(); slot = 0; }
    const col = slot % L.cols;
    const row = Math.floor(slot / L.cols);
    const x = (L.left + col * (L.w + L.gapX)) * MM + 8;
    const y = (L.top + row * (L.h + L.gapY)) * MM + 6;
    const lines = [salutationOf(f), ...formatAddress(f)];
    doc.font('Helvetica').fontSize(L.h > 30 ? 10 : 8.5);
    doc.text(lines.join('\n'), x, y, { width: L.w * MM - 16, height: L.h * MM - 10, ellipsis: true, lineGap: 0.5 });
    slot++;
  }
  return toBuffer(doc);
}

export async function envelopesPdf(settings, families, sizeKey = 'dl') {
  const E = ENVELOPE_SIZES[sizeKey] || ENVELOPE_SIZES.dl;
  const doc = newDoc({ size: E.size, margin: 0, autoFirstPage: false });
  const [w, h] = E.size;
  for (const f of families) {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).text(settings.org_name || '', 20, 20, { width: w / 2 });
    doc.font('Helvetica').fontSize(8).text(settings.org_address || '', { width: w / 2 });
    doc.fontSize(12).text([salutationOf(f), ...formatAddress(f)].join('\n'), w * 0.45, h * 0.45, { width: w * 0.5 });
  }
  return toBuffer(doc);
}
