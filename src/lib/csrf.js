// Synchronizer-token CSRF protection for session-backed forms.
import crypto from 'node:crypto';

export function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrfToken = req.session.csrf;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.body?._csrf || req.get('x-csrf-token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(req.session.csrf);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(403).render('error', { title: 'Form expired', message: 'Your form session expired. Please go back, reload the page and try again.' });
}
