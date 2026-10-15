import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import { config } from './config.js';
import { getSettings } from './db/index.js';
import { SqliteStore } from './lib/sessionStore.js';
import { csrf } from './lib/csrf.js';
import { can, requireLogin } from './lib/permissions.js';
import { formatMoney, formatAddress, formatCep, salutationOf } from './lib/format.js';
import { formatHebrew, toHebrew, OCCASION_LABELS } from './lib/hebrew.js';
import { setupAuth, authRoutes } from './routes/auth.js';
import publicRoutes from './routes/public.js';
import dashboardRoutes from './routes/dashboard.js';
import familyRoutes from './routes/families.js';
import categoryRoutes from './routes/categories.js';
import occasionRoutes from './routes/occasions.js';
import financeRoutes from './routes/finance.js';
import orderRoutes from './routes/orders.js';
import eventRoutes from './routes/events.js';
import commsRoutes from './routes/comms.js';
import adminRoutes from './routes/admin.js';
import apiRoutes from './routes/api.js';
import webhookRoutes from './routes/webhooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp(db) {
  const app = express();
  app.set('db', db);
  app.set('view engine', 'ejs');
  app.set('views', path.join(here, 'views'));
  if (config.isProd) app.set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
          formAction: ["'self'", 'https://accounts.google.com', 'https://checkout.stripe.com'],
          upgradeInsecureRequests: config.isProd ? [] : null,
        },
      },
    }),
  );

  // Stripe needs the raw body to verify signatures, so mount before body parsers.
  app.use('/webhooks', express.raw({ type: 'application/json' }), webhookRoutes);

  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/static', express.static(path.join(here, '..', 'public'), { maxAge: config.isProd ? '7d' : 0 }));

  app.use(
    session({
      store: new SqliteStore(db),
      secret: config.sessionSecret,
      name: 'cp.sid',
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 1000 * 60 * 60 * 12 },
    }),
  );

  const auth = setupAuth(app, db);

  app.use((req, res, next) => {
    const settings = getSettings(db);
    Object.assign(res.locals, {
      user: req.user || null,
      can: (perm) => can(req.user, perm),
      settings,
      path: req.path,
      flash: req.session.flash || [],
      formatMoney, formatAddress, formatCep, salutationOf, formatHebrew, toHebrew, OCCASION_LABELS,
      title: '',
    });
    delete req.session.flash;
    req.flash = (type, message) => {
      (req.session.flash ||= []).push({ type, message });
    };
    next();
  });
  app.use(csrf);

  app.use(authRoutes(db, auth));
  app.use('/', publicRoutes);
  app.use('/api', requireLogin, apiRoutes);
  app.use('/', requireLogin, dashboardRoutes);
  app.use('/families', requireLogin, familyRoutes);
  app.use('/categories', requireLogin, categoryRoutes);
  app.use('/occasions', requireLogin, occasionRoutes);
  app.use('/finance', requireLogin, financeRoutes);
  app.use('/orders', requireLogin, orderRoutes);
  app.use('/events', requireLogin, eventRoutes);
  app.use('/comms', requireLogin, commsRoutes);
  app.use('/admin', requireLogin, adminRoutes);

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const status = err.status || 500;
    const message = status < 500 || !config.isProd ? err.message : 'Something went wrong.';
    if (req.path.startsWith('/api')) return res.status(status).json({ error: message });
    res.status(status).render('error', { title: 'Error', message });
  });
  return app;
}
