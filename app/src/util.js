'use strict';
// Utilitaires cryptographiques — tout repose sur node:crypto (0 dépendance).
import { createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

export const sha256hex = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Comparaison de chaînes à temps constant, indépendante du contenu ET de la longueur :
 * on compare les condensés SHA-256 (32 octets fixes) via timingSafeEqual. La brute-force
 * par mesure de temps est sans effet, et aucune exception de longueur ne fuite.
 */
export function constantTimeEquals(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** HMAC-SHA-256 hex (webhooks SasPay). */
export const hmacHex = (secret, msg) => createHmac('sha256', secret).update(msg).digest('hex');

/** Mot de passe : scrypt (N=16384, r=8, p=1), sel 16 o, format auto-descriptif. */
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const N = 16384, r = 8, p = 1;
  const key = await scrypt(password.normalize('NFKC'), salt, 32, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, saltHex, keyHex] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const key = await scrypt(password.normalize('NFKC'), Buffer.from(saltHex, 'hex'), 32, { N: +N, r: +r, p: +p });
  return timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}

/** Jeton de session : 32 o aléatoires, base64url ; seul le condensé est stocké. */
export const newSessionToken = () => randomBytes(32).toString('base64url');
export const newState = () => randomBytes(24).toString('base64url');

// ── Chiffrement AES-256-GCM au repos (jetons OAuth) — clé dérivée de APP_SECRET_KEY ──
const encKey = (secret) => createHash('sha256').update('clearmatch-oauth-v1:' + secret).digest();

export function encryptSecret(plain, secret) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey(secret), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

export function decryptSecret(blob, secret) {
  const [ivB64, tagB64, dataB64] = String(blob).split('.');
  const decipher = createDecipheriv('aes-256-gcm', encKey(secret), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** JSON stable (clés triées) pour hacher des payloads. Les Date deviennent ISO
 *  (sinon '{}' : les propriétés d'un Date ne sont pas énumérables — rupture de chaîne). */
export function stableJson(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableJson(value[k])).join(',') + '}';
}

export const nowIso = () => new Date().toISOString();
