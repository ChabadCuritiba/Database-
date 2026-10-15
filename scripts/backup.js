// One-off backup from the command line. Usage: npm run backup
import { openDb } from '../src/db/index.js';
import { runBackup } from '../src/lib/backup.js';

const r = await runBackup(openDb());
console.log('Backup written to', r.file, r.uploaded ? `and ${r.uploaded}` : '');
