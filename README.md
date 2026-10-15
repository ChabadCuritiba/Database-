# Community Platform

Contact, Hebrew-calendar, donations, events and communications management for a Jewish community / Chabad House. Node.js + SQLite, server-rendered, no build step.

## Features

| Area | What it does |
| --- | --- |
| **Contacts & families** | Households with primary contact, spouse, children, parents and other relatives; Hebrew names (with father's/mother's name), Kohen/Levi/Yisrael; affiliation, priority (1–5), source, CPF/CNPJ, opt-outs (mail/email/SMS) and admin-defined custom fields. CSV export. |
| **Categories** | Unlimited nested categories and sub-categories. Filtering by a category includes its sub-categories; match *any* or *all*. Bulk tagging from search results. |
| **Hebrew calendar** | Built-in engine ([@hebcal/core](https://github.com/hebcal/hebcal-es6)) converts civil dates to Hebrew dates (with "after sunset"), computes the next Yahrzeit, Hebrew birthday, anniversary and Bar/Bat Mitzvah dates, handling Adar I/II and other edge cases. Converter page in both directions. |
| **Automated reminders** | Daily job emails and/or texts families before Yahrzeits, birthdays and anniversaries. Each reminder is sent once per observance. |
| **Yahrzeit letters** | Printable letters with the Hebrew date in Hebrew script and the civil date, as PDF or Microsoft Word. |
| **Donations & pledges** | Donations split across any number of funds (General, Building Fund, Holiday Appeals…), pledges with balances, payment methods (cash, check, PIX, card, transfer, online). |
| **Receipts & thank-yous** | Sequential receipt numbers; single or batch receipt PDFs; thank-you letters (PDF / Word / email with receipt attached); year-end contribution statements (PDF or email). |
| **Judaica & holiday orders** | Product catalog by season (Shmura Matzah, Arba Minim, Tefillin, Mezuzah…), family orders, payments and balances, procurement totals per product, online payment links. |
| **Events** | Dinners, classes, lectures, Shabbatons with adult / student / child pricing and counts, capacity, check-in, CSV. Public sign-up page with online payment. |
| **Communications** | Email, SMS and robo-call campaigns to any contact selection, with merge fields; mailing labels (Avery 5160 / Pimaco 6180, A4 sheets), envelopes and merged letters (PDF or Word). |
| **Buggy voice assistant** | Talk or type in Portuguese, English or Hebrew: "Adiciona Joseli e Dimini aos contatos, email …". Powered by Google Gemini; searches and reads instantly and creates new contacts right away (asking first only when a similar contact exists); donations, Yahrzeits and other changes wait for your confirmation. Respects the user's role; everything is written to the audit log. Installable on the phone home screen; opens by voice through Siri Shortcuts or "Ok Google". |
| **Integrations** | ViaCEP address auto-fill, Microsoft Word (.docx), Twilio (SMS + voice), SMTP email, Stripe Checkout, Google sign-in, optional Google Cloud Storage backups. |
| **Security** | "Continue with Google" sign-in for invited users only, role-based access, CSRF protection, security headers, audit log, nightly backups with retention. |

### Roles

| Role | Can do |
| --- | --- |
| `admin` | Everything: users & roles, settings, templates, backups, deletions, audit log |
| `finance` | Contacts, donations, pledges, receipts, statements, orders, events, communications |
| `staff` | Contacts, occasions, orders, events, communications — **no** financial records |
| `volunteer` | View contacts; may update **only** phone numbers, email and address |

### PCI compliance

Online payments use **Stripe Checkout**: card details are entered on Stripe's hosted page and never reach this server, keeping you in the lightest PCI scope (SAQ‑A). No card data is stored in the database.

## Getting started

Requires Node.js 20+ ([download](https://nodejs.org)).

### Quick local demo

```bash
git clone -b claude/jewish-community-platform-7zr3fp https://github.com/ChabadCuritiba/Database-.git
cd Database-
npm install
npm run demo
```

Open http://localhost:3000, choose a role under **Development login** and click **Sign in (dev)**. Demo data lives in `data/community.db`; delete that file to start fresh.

### Real setup

```bash
npm install
cp .env.example .env        # then edit it
npm run seed                # optional demo data
npm start                   # http://localhost:3000
```

To try it locally without Google credentials, set `DEV_LOGIN=1` and `NODE_ENV=development` in `.env`; the login page then offers a development sign-in for any email and role.

### Google sign-in

1. Google Cloud Console → *APIs & Services* → *Credentials* → *Create OAuth client ID* (Web application).
2. Add `https://YOUR-DOMAIN/auth/google/callback` as an authorized redirect URI.
3. Put the client ID/secret in `.env` and your own email in `ADMIN_EMAILS`.
4. Sign in, then invite colleagues under **Admin › Users & roles**. Only invited emails can sign in.

### Stripe

Set `STRIPE_SECRET_KEY`, then add a webhook endpoint `https://YOUR-DOMAIN/webhooks/stripe` for the events `checkout.session.completed` and `checkout.session.async_payment_succeeded`, and copy its signing secret to `STRIPE_WEBHOOK_SECRET`. This enables `/donate`, paid event sign-ups and order payment links. Online donations are matched to contacts by email.

### Email, SMS and calls

Configure SMTP for email and Twilio for SMS and robo-calls. When a provider is not configured, messages are logged as **simulated** instead of being sent, which is handy for testing.

### Backups

A backup of the SQLite database is taken every night (`BACKUP_CRON`), keeping the last `BACKUP_KEEP` copies in `BACKUP_DIR`. Admins can also back up and download from **Admin › Backups**. Set `GCS_BUCKET` (and `npm install @google-cloud/storage`) to copy each backup to Google Cloud Storage.

## Deployment notes

**Step-by-step guide for a free Google Cloud VM: [deploy/GUIDE.md](deploy/GUIDE.md).**

- Run behind HTTPS (e.g. Google Cloud Run, a VM with Caddy/Nginx). With `NODE_ENV=production` cookies are `Secure` and `SESSION_SECRET` is required.
- The database is a single file (`DATABASE_PATH`); put it on a persistent disk.
- Scheduled jobs (reminders, backups) run inside the app process. Run a single instance.

## Development

```bash
npm run dev     # restart on file changes
npm test        # node:test suite (unit + HTTP integration tests)
```

Layout:

```
src/
  app.js            Express app factory
  server.js         entry point + scheduled jobs
  db/               schema and database helpers
  lib/              hebrew calendar, finance, pdf, word, messaging, permissions…
  routes/           one router per area
  views/            EJS templates
public/             CSS and progressive-enhancement JS
scripts/seed.js     demo data
test/               tests
```
