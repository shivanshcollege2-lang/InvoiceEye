import jwt from 'jsonwebtoken';
import { OAuth2Client } from 'google-auth-library';
import { getPool } from '../db/index.js';

const SECRET = process.env.JWT_SECRET || 'invoiceeye-development-secret';
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;
const DEFAULT_ADMIN_EMAILS = ['shivanshcollege2@gmail.com'];
const DEFAULT_REVIEWER_EMAILS = ['reviewer@example.test'];

export function getAdminAllowlist() {
  const values = [
    ...DEFAULT_ADMIN_EMAILS,
    process.env.ADMIN_EMAIL_ALLOWLIST,
    process.env.ADMIN_ALLOWED_EMAILS,
    process.env.GOOGLE_ADMIN_EMAILS,
    process.env.OWNER_EMAIL
  ].filter(Boolean).flatMap(value => String(value).split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
  return new Set(values);
}

function getReviewerAllowlist() {
  const values = [
    ...DEFAULT_REVIEWER_EMAILS,
    process.env.REVIEWER_EMAIL_ALLOWLIST,
    process.env.REVIEWER_ALLOWED_EMAILS
  ].filter(Boolean).flatMap(value => String(value).split(',').map(part => part.trim().toLowerCase()).filter(Boolean));
  return new Set(values);
}

export async function resolveIdentityRole(email, name = '') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) return 'vendor';
  if (getAdminAllowlist().has(normalizedEmail)) return 'admin';

  const normalizedName = String(name || '').trim().toLowerCase();
  if (getReviewerAllowlist().has(normalizedEmail) || normalizedEmail.includes('reviewer') || normalizedName.includes('reviewer')) {
    return 'reviewer';
  }

  try {
    const pool = getPool();
    const [rows] = await pool.query(
      'SELECT vendor_id FROM vendors WHERE LOWER(email)=LOWER(?) OR LOWER(name)=LOWER(?) LIMIT 1',
      [normalizedEmail, normalizedName]
    );
    if (rows.length) return 'vendor';
  } catch {
    // Fall through to vendor role for valid Google-backed users when a mapped vendor record is not yet stored.
  }
  return 'vendor';
}

export async function verifyGoogleIdentityToken(token) {
  if (!token) throw new Error('Google identity token is required.');
  if (!googleClient || !process.env.GOOGLE_CLIENT_ID) {
    throw new Error('Google login is not configured on this server.');
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: token,
    audience: process.env.GOOGLE_CLIENT_ID
  });

  const payload = ticket.getPayload();
  if (!payload?.email || payload.email_verified !== true) {
    throw new Error('Google account email is not verified.');
  }
  return payload;
}

export function signToken(user) {
  return jwt.sign({
    id: user.user_id ?? user.id,
    email: user.email,
    role: user.role,
    name: user.name,
    vendorId: user.vendor_id ?? user.vendorId ?? null
  }, SECRET, { expiresIn: '8h' });
}

export async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ message: 'Authentication required' });
  try {
    req.user = jwt.verify(token, SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }

  const [rows] = await getPool().query(
    `SELECT u.user_id, u.name, u.email, u.role, u.is_active, v.vendor_id
     FROM users u
     LEFT JOIN vendors v ON LOWER(v.email)=LOWER(u.email)
     WHERE u.user_id=? AND u.is_active=1 LIMIT 1`,
    [req.user.id]
  );

  if (!rows.length) return res.status(401).json({ message: 'Account is inactive' });
  const user = rows[0];
  req.user = {
    id: user.user_id,
    user_id: user.user_id,
    email: user.email,
    role: user.role,
    name: user.name,
    vendorId: user.vendor_id || null
  };
  next();
}

export function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission for this operation' });
    }
    next();
  };
}
