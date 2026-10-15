// Central configuration, read from environment variables.
// See .env.example for documentation of each value.
import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the app runs without extra dependencies.
const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const config = {
  env: env.NODE_ENV || 'development',
  isProd: env.NODE_ENV === 'production',
  port: Number(env.PORT || 3000),
  baseUrl: (env.BASE_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, ''),
  sessionSecret: env.SESSION_SECRET || 'dev-only-insecure-secret',
  dbPath: env.DATABASE_PATH || path.resolve('data', 'community.db'),

  // Google sign-in ("Continue with Google")
  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    allowedDomain: (env.GOOGLE_ALLOWED_DOMAIN || '').toLowerCase(),
  },
  // Emails that are automatically promoted to admin on first sign-in.
  adminEmails: list(env.ADMIN_EMAILS),
  // Development-only password-less login, never available in production.
  devLogin: env.DEV_LOGIN === '1' && env.NODE_ENV !== 'production',

  locale: env.LOCALE || 'pt-BR',
  currency: env.CURRENCY || 'BRL',
  timezone: env.TZ || 'America/Sao_Paulo',

  smtp: {
    host: env.SMTP_HOST || '',
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === '1',
    user: env.SMTP_USER || '',
    // Google shows App Passwords with spaces ("abcd efgh ijkl mnop"); Gmail expects them without.
    pass: /gmail\.com$|googlemail\.com$/i.test(env.SMTP_HOST || '') ? (env.SMTP_PASS || '').replace(/\s+/g, '') : env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'no-reply@example.org',
  },
  twilio: {
    accountSid: env.TWILIO_ACCOUNT_SID || '',
    authToken: env.TWILIO_AUTH_TOKEN || '',
    from: env.TWILIO_FROM || '',
  },
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  backup: {
    dir: env.BACKUP_DIR || path.resolve('backups'),
    keep: Number(env.BACKUP_KEEP || 30),
    cron: env.BACKUP_CRON || '0 3 * * *',
    gcsBucket: env.GCS_BUCKET || '',
  },
  reminderCron: env.REMINDER_CRON || '0 8 * * *',
  viacepUrl: env.VIACEP_URL || 'https://viacep.com.br/ws',
};
