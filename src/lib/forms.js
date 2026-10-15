// Small helpers for turning form bodies into clean column values.
export const str = (v) => {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
};
export const bool = (v) => (v === '1' || v === 'on' || v === true || v === 'true' ? 1 : 0);
export const int = (v, dflt = null) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
};
export const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
export const ids = (v) => (Array.isArray(v) ? v : v === undefined || v === '' ? [] : [v]).map(Number).filter((n) => n > 0);
export const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

/** Fetch a row by id or throw 404. */
export function mustGet(db, table, id) {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(Number(id));
  if (!row) throw httpError(404, 'Record not found');
  return row;
}

export function toCsv(rows, columns) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [columns.map((c) => esc(c.label)).join(','), ...rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(','))].join('\r\n');
}
