import { findOrAdmitUser } from '../src/routes/auth.js';
export const findAdmissible = (db, email) => findOrAdmitUser(db, { email, name: 'Test', googleId: null });
