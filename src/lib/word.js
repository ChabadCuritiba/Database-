// Microsoft Word (.docx) output for merged letters, so staff can fine-tune
// formatting in Word before printing.
import { AlignmentType, Document, Packer, Paragraph, TextRun, PageBreak } from 'docx';
import { formatAddress, salutationOf } from './format.js';
import { formatGregorian } from './hebrew.js';
import { config } from '../config.js';

const HEBREW_RE = /[֐-׿]/;

function runsFor(text, opts = {}) {
  const lines = String(text).split('\n');
  return lines.map(
    (line, i) =>
      new TextRun({
        text: line,
        break: i > 0 ? 1 : undefined,
        rightToLeft: HEBREW_RE.test(line) && !/[A-Za-z]/.test(line),
        font: HEBREW_RE.test(line) ? { ascii: 'Calibri', cs: 'David' } : 'Calibri',
        size: 22,
        ...opts,
      }),
  );
}

/** letters: [{ family, body, hebrewLine? }] */
export async function lettersDocx(settings, letters, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const children = [];
  letters.forEach((l, i) => {
    if (i) children.push(new Paragraph({ children: [new PageBreak()] }));
    children.push(
      new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: settings.org_name || '', bold: true, size: 32 })] }),
    );
    const sub = [settings.org_address, settings.org_phone, settings.org_email].filter(Boolean).join('  ·  ');
    if (sub) children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: sub, size: 18, color: '555555' })] }));
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: runsFor(formatGregorian(date, config.locale)) }));
    if (l.hebrewLine) children.push(new Paragraph({ alignment: AlignmentType.RIGHT, children: runsFor(l.hebrewLine) }));
    children.push(new Paragraph({ text: '' }));
    children.push(new Paragraph({ children: runsFor([salutationOf(l.family), ...formatAddress(l.family)].join('\n')) }));
    children.push(new Paragraph({ text: '' }));
    for (const para of String(l.body).split(/\n{2,}/)) {
      children.push(new Paragraph({ spacing: { after: 200 }, children: runsFor(para) }));
    }
    children.push(new Paragraph({ text: '' }));
    if (settings.signature_name) children.push(new Paragraph({ children: runsFor(settings.signature_name) }));
    if (settings.signature_title) children.push(new Paragraph({ children: runsFor(settings.signature_title, { color: '555555' }) }));
  });
  const doc = new Document({ creator: settings.org_name || 'Community Platform', sections: [{ children }] });
  return Packer.toBuffer(doc);
}
