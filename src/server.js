import dns from 'node:dns';
import cron from 'node-cron';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { createApp } from './app.js';
import { sendDueReminders } from './lib/occasions.js';
import { runBackup } from './lib/backup.js';

// Cloud VMs often have no IPv6 route; trying IPv4 first avoids hanging connections.
dns.setDefaultResultOrder('ipv4first');

if (config.isProd && config.sessionSecret === 'dev-only-insecure-secret') {
  console.error('SESSION_SECRET must be set in production.');
  process.exit(1);
}

const db = openDb();
const app = createApp(db);

cron.schedule(config.reminderCron, async () => {
  try {
    const stats = await sendDueReminders(db);
    console.log('[reminders]', stats);
  } catch (e) {
    console.error('[reminders] failed', e);
  }
}, { timezone: config.timezone });

cron.schedule(config.backup.cron, async () => {
  try {
    const r = await runBackup(db);
    console.log('[backup]', r.file, r.uploaded || '');
  } catch (e) {
    console.error('[backup] failed', e);
  }
}, { timezone: config.timezone });

app.listen(config.port, () => {
  console.log(`Community platform listening on ${config.baseUrl} (port ${config.port})`);
  if (config.devLogin) console.log('DEV_LOGIN is enabled – do not use in production.');
});
