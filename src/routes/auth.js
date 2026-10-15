// "Continue with Google" sign-in. Only invited users (or ADMIN_EMAILS) may enter;
// roles are assigned by an admin under Admin › Users.
import express from 'express';
import { Passport } from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';
import { config } from '../config.js';
import { ROLES } from '../lib/permissions.js';
import { audit } from '../lib/audit.js';

export function findOrAdmitUser(db, { email, name, googleId }) {
  email = String(email || '').toLowerCase();
  if (!email) return { error: 'Your Google account did not provide an email address.' };
  if (config.google.allowedDomain && !email.endsWith(`@${config.google.allowedDomain}`)) {
    return { error: `Only @${config.google.allowedDomain} accounts may sign in.` };
  }
  let user =
    (googleId && db.prepare('SELECT * FROM users WHERE google_id = ?').get(googleId)) ||
    db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    if (!config.adminEmails.includes(email)) {
      return { error: `${email} has not been invited. Ask an administrator to add you.` };
    }
    const { lastInsertRowid } = db.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'admin')").run(email, name || email);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid);
  }
  if (!user.active) return { error: 'Your account has been deactivated.' };
  db.prepare("UPDATE users SET google_id = COALESCE(?, google_id), name = COALESCE(name, ?), last_login = datetime('now') WHERE id = ?").run(
    googleId || null, name || null, user.id,
  );
  return { user: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id) };
}

export function setupAuth(app, db) {
  // One Passport instance per app keeps strategies bound to this app's database.
  const passport = new Passport();
  app.set('passport', passport);
  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser((id, done) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id);
    done(null, user || false);
  });

  const googleEnabled = !!(config.google.clientId && config.google.clientSecret);
  if (googleEnabled) {
    passport.use(
      new GoogleStrategy(
        {
          clientID: config.google.clientId,
          clientSecret: config.google.clientSecret,
          callbackURL: `${config.baseUrl}/auth/google/callback`,
        },
        (accessToken, refreshToken, profile, done) => {
          const email = profile.emails?.find((e) => e.verified !== false)?.value;
          const r = findOrAdmitUser(db, { email, name: profile.displayName, googleId: profile.id });
          if (r.error) return done(null, false, { message: r.error });
          audit(db, r.user, 'login', 'user', r.user.id, 'google');
          done(null, r.user);
        },
      ),
    );
  }

  app.use(passport.initialize());
  app.use(passport.session());
  return { googleEnabled, passport };
}

export function authRoutes(db, { googleEnabled, passport }) {
  const app = express.Router();
  app.get('/login', (req, res) => {
    if (req.user) return res.redirect('/');
    const error = req.session.authError;
    delete req.session.authError;
    res.render('login', { title: 'Sign in', googleEnabled, devLogin: config.devLogin, roles: ROLES, error });
  });

  if (googleEnabled) {
    app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'], prompt: 'select_account' }));
    app.get('/auth/google/callback', (req, res, next) => {
      passport.authenticate('google', (err, user, info) => {
        if (err) return next(err);
        if (!user) {
          req.session.authError = info?.message || 'Sign-in failed.';
          return res.redirect('/login');
        }
        const returnTo = req.session.returnTo || '/';
        req.logIn(user, (e) => (e ? next(e) : res.redirect(returnTo)));
      })(req, res, next);
    });
  }

  if (config.devLogin) {
    // Development only: sign in as any email/role without Google.
    app.post('/auth/dev', (req, res, next) => {
      const email = String(req.body.email || 'dev@example.org').toLowerCase();
      const role = ROLES.includes(req.body.role) ? req.body.role : 'admin';
      db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?) ON CONFLICT(email) DO UPDATE SET role = excluded.role, active = 1').run(email, email, role);
      const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      req.logIn(user, (e) => (e ? next(e) : res.redirect('/')));
    });
  }

  app.post('/logout', (req, res, next) => {
    req.logout((e) => {
      if (e) return next(e);
      req.session.destroy(() => res.redirect('/login'));
    });
  });
  return app;
}
