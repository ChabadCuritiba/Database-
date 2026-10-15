// Outbound email (SMTP via nodemailer), SMS and robo-calls (Twilio).
// When a provider is not configured, messages are recorded as "simulated"
// so the system can be evaluated safely without sending anything.
import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { escapeHtml } from './format.js';

let transport;
let twilioClient;

function mailTransport() {
  if (!transport) {
    transport = config.smtp.host
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
        })
      : null;
  }
  return transport;
}

async function twilio() {
  if (!config.twilio.accountSid) return null;
  if (!twilioClient) {
    const { default: Twilio } = await import('twilio');
    twilioClient = Twilio(config.twilio.accountSid, config.twilio.authToken);
  }
  return twilioClient;
}

// Tests replace these to capture traffic.
export const providers = {
  async email(msg) {
    const t = mailTransport();
    if (!t) return { status: 'simulated' };
    const info = await t.sendMail({ from: config.smtp.from, ...msg });
    return { status: 'sent', id: info.messageId };
  },
  async sms({ to, body }) {
    const c = await twilio();
    if (!c) return { status: 'simulated' };
    const m = await c.messages.create({ to, from: config.twilio.from, body });
    return { status: 'sent', id: m.sid };
  },
  async call({ to, message, audioUrl, language = 'pt-BR' }) {
    const c = await twilio();
    if (!c) return { status: 'simulated' };
    const twiml = audioUrl
      ? `<Response><Play>${escapeHtml(audioUrl)}</Play></Response>`
      : `<Response><Say language="${escapeHtml(language)}">${escapeHtml(message)}</Say></Response>`;
    const call = await c.calls.create({ to, from: config.twilio.from, twiml });
    return { status: 'sent', id: call.sid };
  },
};

/** Normalise a Brazilian phone number to E.164 (+55...). Other numbers pass through. */
export function toE164(phone, defaultCountry = '55') {
  const raw = String(phone || '').trim();
  if (!raw) return '';
  if (raw.startsWith('+')) return '+' + raw.replace(/\D/g, '');
  const digits = raw.replace(/\D/g, '').replace(/^0+/, '');
  if (!digits) return '';
  return digits.length <= 11 ? `+${defaultCountry}${digits}` : `+${digits}`;
}

/** Send through a channel and record the outcome in message_log. Never throws. */
export async function deliver(db, { channel, to, subject, html, text, body, message, audioUrl, attachments, familyId, campaignId }) {
  let result;
  try {
    if (!to) throw new Error('No recipient');
    if (channel === 'email') result = await providers.email({ to, subject, html, text, attachments });
    else if (channel === 'sms') result = await providers.sms({ to: toE164(to), body });
    else if (channel === 'call') result = await providers.call({ to: toE164(to), message, audioUrl });
    else throw new Error(`Unknown channel ${channel}`);
  } catch (e) {
    result = { status: 'failed', error: e.message };
  }
  db.prepare(
    'INSERT INTO message_log (campaign_id, family_id, channel, recipient, subject, status, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(campaignId ?? null, familyId ?? null, channel, to || '', subject ?? null, result.status, result.error ?? null);
  return result;
}
