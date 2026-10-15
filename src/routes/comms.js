// Communications: email/SMS/robo-call campaigns and print mailings
// (labels, envelopes, merged letters in PDF or Microsoft Word).
import express from 'express';
import { requirePermission } from '../lib/permissions.js';
import { findFamilies, categoryTree, normalizeCriteria } from '../lib/contactQuery.js';
import { deliver } from '../lib/messaging.js';
import { labelsPdf, envelopesPdf, lettersPdf, LABEL_LAYOUTS, ENVELOPE_SIZES } from '../lib/pdf.js';
import { lettersDocx } from '../lib/word.js';
import { getSettings } from '../db/index.js';
import { merge, salutationOf, textToHtml, formatAddress } from '../lib/format.js';
import { audit } from '../lib/audit.js';
import { str, oneOf, mustGet, httpError } from '../lib/forms.js';

const router = express.Router();
router.use(requirePermission('comms.send'));

const CHANNELS = ['email', 'sms', 'call'];
const AUDIENCES = ['all', 'pick', 'filter'];
const REQUIRE_FOR = { email: 'email', sms: 'mobile', call: 'mobile', print: 'address' };

export function mergeFields(family, settings) {
  return {
    salutation: salutationOf(family),
    family_name: family.family_name,
    hebrew_name: family.hebrew_name || '',
    email: family.email || '',
    city: family.city || '',
    address: formatAddress(family).join(', '),
    org_name: settings.org_name,
  };
}

/**
 * Recipient criteria from a compose form:
 *   all=1          every contact reachable on the channel
 *   familyIds[]    only the contacts picked from the dropdown
 *   otherwise      the category / priority / ... filters
 * The preview page passes the resolved `audience` along explicitly.
 */
export function audienceCriteria(body, channel) {
  const c = normalizeCriteria(body);
  const audience = AUDIENCES.includes(body.audience) ? body.audience
    : body.all === '1' ? 'all' : c.familyIds.length ? 'pick' : 'filter';
  let criteria;
  if (audience === 'all') criteria = normalizeCriteria({});
  else if (audience === 'pick') criteria = { ...normalizeCriteria({}), familyIds: c.familyIds.length ? c.familyIds : [-1] };
  else criteria = { ...c, familyIds: [] };
  return { audience, criteria: { ...criteria, require: REQUIRE_FOR[channel] } };
}

/** Contacts that can be picked individually for a channel. */
function pickable(db, channel) {
  const col = channel === 'email' ? 'email' : 'mobile';
  const optOut = channel === 'email' ? 'no_email' : 'no_sms';
  return db.prepare(`SELECT id, family_name, salutation, ${col} contact FROM families
    WHERE COALESCE(${col},'') <> '' AND ${optOut} = 0 ORDER BY family_name COLLATE NOCASE`).all();
}

function lookups(db) {
  const distinct = (col) => db.prepare(`SELECT DISTINCT ${col} v FROM families WHERE COALESCE(${col},'') <> '' ORDER BY 1`).all().map((r) => r.v);
  return { categories: categoryTree(db), affiliations: distinct('affiliation'), sources: distinct('source'), cities: distinct('city') };
}

router.get('/', (req, res) => {
  const db = req.app.get('db');
  const campaigns = db.prepare('SELECT c.*, u.name user_name FROM campaigns c LEFT JOIN users u ON u.id = c.created_by ORDER BY c.id DESC LIMIT 50').all();
  const log = db.prepare('SELECT * FROM message_log ORDER BY id DESC LIMIT 30').all();
  res.render('comms/index', { title: 'Communications', campaigns, log });
});

router.get('/compose', (req, res) => {
  const db = req.app.get('db');
  const channel = oneOf(req.query.channel, CHANNELS, 'email');
  const criteria = normalizeCriteria(req.query);
  const contacts = pickable(db, channel);
  res.render('comms/compose', { title: 'New campaign', channel, criteria, contacts, ...lookups(db) });
});

router.post('/preview', (req, res) => {
  const db = req.app.get('db');
  const channel = oneOf(req.body.channel, CHANNELS, 'email');
  const { audience, criteria } = audienceCriteria(req.body, channel);
  const { rows, total } = findFamilies(db, criteria, { limit: 200 });
  const settings = getSettings(db);
  const sample = rows[0] ? merge(req.body.body, mergeFields(rows[0], settings)) : '';
  res.render('comms/preview', { title: 'Review campaign', channel, rows, total, body: req.body, criteria, audience, sample });
});

router.post('/send', async (req, res) => {
  const db = req.app.get('db');
  const channel = oneOf(req.body.channel, CHANNELS, 'email');
  const body = str(req.body.body);
  const subject = str(req.body.subject);
  if (!body) throw httpError(400, 'Message body is required');
  if (channel === 'email' && !subject) throw httpError(400, 'Subject is required');
  const { criteria } = audienceCriteria(req.body, channel);
  const { rows } = findFamilies(db, criteria);
  const settings = getSettings(db);
  const { lastInsertRowid: campaignId } = db.prepare('INSERT INTO campaigns (channel, subject, body, criteria, created_by) VALUES (?, ?, ?, ?, ?)').run(
    channel, subject, body, JSON.stringify(criteria), req.user.id,
  );
  let sent = 0;
  let failed = 0;
  for (const f of rows) {
    const data = mergeFields(f, settings);
    const text = merge(body, data);
    const msg = { channel, familyId: f.id, campaignId };
    if (channel === 'email') Object.assign(msg, { to: f.email, subject: merge(subject, data), text, html: textToHtml(text) });
    if (channel === 'sms') Object.assign(msg, { to: f.mobile, body: text });
    if (channel === 'call') Object.assign(msg, { to: f.mobile, message: text, audioUrl: str(req.body.audio_url) });
    const r = await deliver(db, msg);
    if (r.status === 'failed') failed++;
    else sent++;
  }
  db.prepare('UPDATE campaigns SET sent_count = ?, fail_count = ? WHERE id = ?').run(sent, failed, campaignId);
  audit(db, req.user, 'send', 'campaign', campaignId, { channel, sent, failed });
  req.flash(failed ? 'warning' : 'success', `Campaign sent: ${sent} delivered${failed ? `, ${failed} failed` : ''}.`);
  res.redirect(`/comms/campaigns/${campaignId}`);
});

router.get('/campaigns/:id', (req, res) => {
  const db = req.app.get('db');
  const campaign = mustGet(db, 'campaigns', req.params.id);
  const log = db.prepare('SELECT m.*, f.family_name FROM message_log m LEFT JOIN families f ON f.id = m.family_id WHERE campaign_id = ? ORDER BY m.id').all(campaign.id);
  res.render('comms/campaign', { title: `Campaign #${campaign.id}`, campaign, log });
});

// --- Print mailings ---
router.get('/print', (req, res) => {
  const db = req.app.get('db');
  const criteria = normalizeCriteria(req.query);
  const { total } = findFamilies(db, { ...criteria, require: 'address' });
  res.render('comms/print', { title: 'Print mailings', criteria, total, layouts: LABEL_LAYOUTS, envelopes: ENVELOPE_SIZES, ...lookups(db) });
});

router.post('/print', async (req, res) => {
  const db = req.app.get('db');
  const settings = getSettings(db);
  const { rows } = findFamilies(db, { ...normalizeCriteria(req.body), require: 'address' });
  if (!rows.length) throw httpError(400, 'No contacts with a postal address match these criteria');
  const [kind, format] = oneOf(req.body.kind, ['labels', 'envelopes', 'letters-pdf', 'letters-docx'], 'labels').split('-');
  audit(db, req.user, 'print', kind, null, { count: rows.length });
  if (kind === 'labels') {
    return res.type('application/pdf').attachment('labels.pdf').send(await labelsPdf(rows, req.body.layout, { startAt: Number(req.body.start_at) || 1 }));
  }
  if (kind === 'envelopes') {
    return res.type('application/pdf').attachment('envelopes.pdf').send(await envelopesPdf(settings, rows, req.body.envelope));
  }
  const template = str(req.body.letter_body);
  if (!template) throw httpError(400, 'Letter text is required');
  const letters = rows.map((f) => ({ family: f, body: merge(template, mergeFields(f, settings)) }));
  if (format === 'docx') {
    return res.type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment('letters.docx').send(await lettersDocx(settings, letters));
  }
  res.type('application/pdf').attachment('letters.pdf').send(await lettersPdf(settings, letters));
});

export default router;
