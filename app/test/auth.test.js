'use strict';
// Authentification & sécurité : mots de passe scrypt, CSRF par origine/en-tête,
// limitation de débit, sessions à jeton opaque (condensé seul en base).
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client } from './helpers.js';
import { hashPassword, verifyPassword, constantTimeEquals, encryptSecret, decryptSecret } from '../src/util.js';

test('mots de passe : scrypt vérifie correctement et refuse les faux', async () => {
  const h = await hashPassword('MotDePasseSûr2026!');
  assert.ok(h.startsWith('scrypt$16384$8$1$'));
  assert.equal(await verifyPassword('MotDePasseSûr2026!', h), true);
  assert.equal(await verifyPassword('mauvais', h), false);
  assert.ok(!h.includes('MotDePasse'), 'jamais de mot de passe en clair');
});

test('comparaison à temps constant : vraie et fausse signature, longueurs différentes', () => {
  assert.equal(constantTimeEquals('abc123def456', 'abc123def456'), true);
  assert.equal(constantTimeEquals('abc123def456', 'ff'), false);
  assert.equal(constantTimeEquals('', 'x'), false);
});

test('jetons OAuth chiffrés AES-256-GCM : round-trip + refus si falsifié', () => {
  const blob = encryptSecret('at_secret_value', 'a'.repeat(32));
  assert.equal(decryptSecret(blob, 'a'.repeat(32)), 'at_secret_value');
  const [iv, tag, data] = blob.split('.');
  assert.throws(() => decryptSecret(`${iv}.${tag}.${data.slice(0, -4)}AAAA`, 'a'.repeat(32)), /auth|fail|decrypt/i);
  assert.throws(() => decryptSecret(blob, 'b'.repeat(32)));
});

test('registre : e-mail invalide, mot de passe faible, doublon → refus explicites', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    assert.equal((await c('POST', '/api/auth/register', { email: 'pasunemail', password: 'motdepasse10', name: 'X' })).status, 400);
    assert.equal((await c('POST', '/api/auth/register', { email: 'a@b.fr', password: 'court', name: 'X' })).status, 400);
    assert.equal((await c('POST', '/api/auth/register', { email: 'a@b.fr', password: 'motdepasse10', name: 'X' })).status, 201);
    assert.equal((await c('POST', '/api/auth/register', { email: 'A@B.FR', password: 'motdepasse10', name: 'X2' })).status, 409, 'unicité réelle (casse normalisée)');
  } finally { await t.close(); }
});

test('CSRF : mutation sans en-tête → 403 ; origine étrangère → 403 ; session requise partout', async () => {
  const t = await boot();
  try {
    const noCsrf = await fetch(`http://127.0.0.1:${t.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'c@d.fr', password: 'motdepasse10', name: 'C' }),
    });
    assert.equal(noCsrf.status, 403);
    const foreign = await fetch(`http://127.0.0.1:${t.port}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ email: 'c@d.fr', password: 'motdepasse10', name: 'C' }),
    });
    assert.equal(foreign.status, 403);

    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'c@d.fr', password: 'motdepasse10', name: 'C' });
    assert.equal((await c('GET', '/api/companies/1/exceptions')).status, 403, 'entreprise d’autrui → pas membre');
    assert.equal((await c('POST', '/api/companies/999/seed-demo', {})).status, 403);
    await c('POST', '/api/auth/logout', {});
    assert.equal((await c('GET', '/api/me')).status, 401, 'après déconnexion, session détruite côté serveur');
  } finally { await t.close(); }
});

test('limitation de débit : 11ᵉ tentative de connexion en <60 s → 429', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await c('POST', '/api/auth/login', { email: 'nobody@x.fr', password: 'motdepasse10' })).status;
    }
    assert.equal(last, 429);
  } finally { await t.close(); }
});

test('rôles : le viewer ne décide pas, l’accountant oui', async () => {
  const t = await boot();
  try {
    const owner = client(t.port);
    await owner('POST', '/api/auth/register', { email: 'owner@t.fr', password: 'motdepasse10', name: 'Owner' });
    await owner('POST', '/api/companies', { name: 'Cabinet' });
    await owner('POST', '/api/companies/1/seed-demo', {});
    const ex = (await owner('GET', '/api/companies/1/exceptions')).json.exceptions;
    const target = ex.find((e) => e.decision === 'proposal');

    const viewer = client(t.port);
    await viewer('POST', '/api/auth/register', { email: 'viewer@t.fr', password: 'motdepasse10', name: 'Viewer' });
    await t.db.query("INSERT INTO memberships (company_id, user_id, role) VALUES (1, 2, 'viewer')");
    const denied = await viewer('POST', `/api/exceptions/${target.id}/decision`, { decision: 'accept', note: '' });
    assert.equal(denied.status, 403);

    await t.db.query("UPDATE memberships SET role = 'accountant' WHERE user_id = 2");
    const allowed = await viewer('POST', `/api/exceptions/${target.id}/decision`, { decision: 'accept', note: 'ok' });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.status, 'validated');
  } finally { await t.close(); }
});
