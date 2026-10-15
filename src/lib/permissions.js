// Role-based access control.
//
//   admin      everything, including users, settings and backups
//   finance    contacts + all financial records + communications
//   staff      contacts, occasions, events, orders and communications; no financial records
//   volunteer  read contacts; may only update phone / address / email fields
export const ROLES = ['admin', 'finance', 'staff', 'volunteer'];

const GRANTS = {
  admin: ['*'],
  finance: [
    'contacts.read', 'contacts.write', 'contacts.contact_info',
    'occasions.read', 'occasions.write',
    'finance.read', 'finance.write',
    'orders.read', 'orders.write',
    'events.read', 'events.write',
    'comms.send',
  ],
  staff: [
    'contacts.read', 'contacts.write', 'contacts.contact_info',
    'occasions.read', 'occasions.write',
    'orders.read', 'orders.write',
    'events.read', 'events.write',
    'comms.send',
  ],
  volunteer: ['contacts.read', 'contacts.contact_info', 'occasions.read', 'events.read'],
};

// The only family fields a user with contacts.contact_info but not contacts.write may change.
export const CONTACT_INFO_FIELDS = [
  'email', 'phone', 'mobile', 'cep', 'street', 'number', 'complement', 'neighborhood', 'city', 'state', 'country',
];

export function can(user, permission) {
  if (!user || !user.active) return false;
  const grants = GRANTS[user.role] || [];
  return grants.includes('*') || grants.includes(permission);
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login');
    if (can(req.user, permission)) return next();
    res.status(403).render('error', { title: 'Access denied', message: 'You do not have permission to view this page.' });
  };
}

export function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}
