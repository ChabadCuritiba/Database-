// Online SQLite backups with retention, optionally copied to Google Cloud Storage.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

export async function runBackup(db, { dir = config.backup.dir, keep = config.backup.keep } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `community-${stamp}.db`);
  await db.backup(file);
  pruneBackups(dir, keep);
  let uploaded = null;
  if (config.backup.gcsBucket) uploaded = await uploadToGcs(file);
  return { file, uploaded };
}

export function listBackups(dir = config.backup.dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^community-.*\.db$/.test(f))
    .map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.name.localeCompare(a.name));
}

function pruneBackups(dir, keep) {
  for (const b of listBackups(dir).slice(keep)) fs.rmSync(path.join(dir, b.name));
}

async function uploadToGcs(file) {
  try {
    // Optional dependency: npm install @google-cloud/storage
    const { Storage } = await import('@google-cloud/storage');
    const dest = `backups/${path.basename(file)}`;
    await new Storage().bucket(config.backup.gcsBucket).upload(file, { destination: dest });
    return `gs://${config.backup.gcsBucket}/${dest}`;
  } catch (e) {
    console.error('[backup] GCS upload failed:', e.message);
    return null;
  }
}
