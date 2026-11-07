'use strict';
// Authentification : scrypt, sessions à jeton opaque (sha256 en base), CSRF par origine,
// limitation de débit sur les points d'entrée sensibles. Zéro dépendance externe.
import { config, isProd } from './config.js';
import { hashPassword, verifyPassword, newSessionToken, sha256hex, nowIso } from './util.js';

export const SESSION_COOKIE = 'clearmatch_sid';
const SESSION_TTL_DAYS = 14;

// ── Utilisateurs ──────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function registerUser(db, { email, password, name }) {
  if (!EMAIL_RE.test(String(email || ''))) throw new HttpError(400, 'invalid_email', 'adresse e-mail invalide');
  if (typeof password !== 'string' || password.length < 10) {
    throw new HttpError(400, 'weak_password', 'mot de passe : 10 caractères minimum');
  }
  if (!name || !String(name).trim()) throw new HttpError(400, 'invalid_name', 'nom requis');
  const emailLc = String(email).toLowerCase().trim();
  const existing = await db.query('SELECT 1 FROM users WHERE email_lc = $1', [emailLc]);
  if (existing.length) throw new HttpError(409, 'email_taken', 'cet e-mail est déjà enregistré');
  const hash = await hashPassword(password);
  const rows = await db.query(
    'INSERT INTO users (email, email_lc, password_hash, name) VALUES ($1, $2, $3, $4) RETURNING id, email, name',
    [String(email).trim(), emailLc, hash, String(name).trim()],
  );
  return rows[0];
}

export async function loginUser(db, { email, password }) {
  const emailLc = String(email || '').toLowerCase().trim();
  const rows = await db.query(
    'SELECT id, email, name, password_hash FROM users WHERE email_lc = $1',
    [emailLc],
  );
  const user = rows[0];
  const ok = user ? await verifyPassword(String(password || ''), user.password_hash) : false;
  if (!ok) throw new HttpError(401, 'bad_credentials', 'e-mail ou mot de passe incorrect');
  return { id: user.id, email: user.email, name: user.name };
}

// ── Sessions ──────────────────────────────────────────────────────────────────
export async function createSession(db, userId) {
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400000);
  await db.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [sha256hex(token), userId, expires.toISOString()],
  );
  return { token, expires };
}

export function sessionCookie(token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${SESSION_TTL_DAYS * 86400}`,
  ];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie() {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isProd) parts.push('Secure');
  return parts.join('; ');
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export async function userFromRequest(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) return null;
  const rows = await db.query(
    `SELECT u.id, u.email, u.name, s.expires_at FROM sessions s
     JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1`,
    [sha256hex(token)],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(token)]);
    return null;
  }
  return { id: row.id, email: row.email, name: row.name };
}

export async function destroySession(db, req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256hex(token)]);
}

// ── Appartenance à une entreprise (isolation tenants) ─────────────────────────
export async function membership(db, companyId, userId) {
  const rows = await db.query(
    'SELECT role FROM memberships WHERE company_id = $1 AND user_id = $2',
    [companyId, userId],
  );
  return rows[0] ?? null;
}

export async function requireMembership(db, companyId, userId, roles = null) {
  const m = await membership(db, companyId, userId);
  if (!m) throw new HttpError(403, 'not_member', 'vous n’êtes pas membre de cette entreprise');
  if (roles && !roles.includes(m.role)) {
    throw new HttpError(403, 'forbidden_role', `rôle « ${m.role} » insuffisant pour cette action`);
  }
  return m;
}

// ── CSRF : toute mutation doit venir de notre origine (fetch du même site) ────
export function checkCsrf(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin) {
    let hostHeader = '';
    try { hostHeader = new URL(origin).host; } catch { /* origine malformée → refus */ }
    if (hostHeader !== host) {
      throw new HttpError(403, 'csrf_origin', 'origine non autorisée');
    }
  }
  // Pas d'origine (curl hors navigateur) : exiger l'en-tête dédié posé par le client de confiance.
  if (!origin && req.headers['x-clearmatch-csrf'] !== '1') {
    throw new HttpError(403, 'csrf_header', 'en-tête x-clearmatch-csrf requis pour les mutations hors navigateur');
  }
}

// ── Limitation de débit (fenêtre fixe en mémoire ; Redis à la mise à l'échelle) ─
const buckets = new Map();

export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) {
    buckets.set(key, { count: 1, reset: now + windowMs });
    return;
  }
  b.count += 1;
  if (b.count > max) {
    throw new HttpError(429, 'rate_limited', 'trop de tentatives — réessayez dans une minute');
  }
}

export function clientIp(req) {
  return (req.socket?.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}
