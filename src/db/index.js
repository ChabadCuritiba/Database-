import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config.js';

const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

const DEFAULT_FUNDS = ['General', 'Building Fund', 'Holiday Appeals', 'Kiddush', 'Education'];
const DEFAULT_SETTINGS = {
  org_name: 'Beit Chabad',
  org_address: '',
  org_tax_id: '',
  org_phone: '',
  org_email: '',
  signature_name: '',
  signature_title: 'Rabbi',
  receipt_footer: 'Thank you for your generous support. No goods or services were provided in exchange for this contribution.',
  thank_you_body:
    'Dear {{salutation}},\n\nThank you for your generous gift of {{amount}} on {{date}} to {{fund}}. Your support makes our work possible.\n\nWith blessings,',
  yahrzeit_body:
    'Dear {{salutation}},\n\nWe wish to remind you that the Yahrzeit of {{name}} ({{hebrew_name}}) will be observed on {{hebrew_date}}, which corresponds to {{gregorian_date}}. The Yahrzeit candle should be lit on the evening before, {{eve_date}}, before sunset.\n\nIt is customary to recite Kaddish, give charity and study Torah in memory of the departed. Please let us know if you would like us to arrange a minyan.\n\nMay the soul of the departed be bound in the bond of life.',
  reminder_email_subject: 'Upcoming {{type}}: {{name}} - {{hebrew_date}}',
  reminder_body:
    'Dear {{salutation}},\n\nThis is a reminder that the {{type}} of {{name}} falls on {{hebrew_date}} ({{gregorian_date}}).\n\nWarm regards,\n{{org_name}}',
  next_receipt_number: '1',
  custom_field_defs: '[]',
};

export function openDb(file = config.dbPath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  seedDefaults(db);
  return db;
}

function seedDefaults(db) {
  const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
  if (!db.prepare('SELECT 1 FROM funds LIMIT 1').get()) {
    const insertFund = db.prepare('INSERT INTO funds (name) VALUES (?)');
    for (const f of DEFAULT_FUNDS) insertFund.run(f);
  }
}

export function getSettings(db) {
  return Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
}

export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    String(value ?? ''),
  );
}

// Allocates the next sequential receipt number atomically.
export function nextReceiptNumber(db) {
  return db.transaction(() => {
    const n = Number(db.prepare("SELECT value FROM settings WHERE key = 'next_receipt_number'").get()?.value || 1);
    const max = db.prepare('SELECT MAX(receipt_number) m FROM payments').get().m || 0;
    const num = Math.max(n, max + 1);
    setSetting(db, 'next_receipt_number', num + 1);
    return num;
  })();
}
