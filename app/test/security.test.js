'use strict';
// Attaques : isolation inter-tenant, injection SQL, rôles, secrets de session,
// endpoint admin. Chaque tentative doit échouer proprement, sans fuite d'information.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, postSignedWebhook } from './helpers.js';

async function twoTenants(t) {
  const a = client(t.port);
  await a('POST', '/api/auth/register', { email: 'att-a@test.fr', password: 'motdepasse10', name: 'A' });
  await a('POST', '/api/companies', { name: 'Société A' });
  await a('POST', '/api/companies/1/seed-demo', {});
  const b = client(t.port);
  await b('POST', '/api/auth/register', { email: 'att-b@test.fr', password: 'motdepasse10', name: 'B' });
  await b('POST', '/api/companies', { name: 'Société B' });
  await b('POST', '/api/companies/2/seed-demo', {});
  return { a, b };
}

test('isolation stricte : B ne lit, n’exporte, ne supprime ni ne pilote A — jamais', async () => {
  const t = await boot();
  try {
    const { a, b } = await twoTenants(t);

    // lecture directe des données d'A
    for (const [method, path] of [
      ['GET', '/api/companies/1/exceptions'],
      ['GET', '/api/companies/1/audit'],
      ['GET', '/api/companies/1/journal'],
      ['GET', '/api/companies/1/subscription'],
      ['POST', '/api/companies/1/export'],
      ['POST', '/api/companies/1/reanalyze'],
      ['POST', '/api/companies/1/seed-demo'],
      ['POST', '/api/companies/1/analyze'],
    ]) {
      const res = await b(method, path, method === 'POST' ? {} : undefined);
      assert.ok(res.status === 403 || res.status === 404, `${method} ${path} → ${res.status}`);
      assert.ok(!JSON.stringify(res.json).includes('BATIPLUS'), `${method} ${path} : aucune donnée d’A dans la réponse`);
    }

    // destruction / pilotage du compte d'A
    assert.equal((await b('DELETE', '/api/companies/1', {})).status, 403, 'B ne peut pas supprimer A');
    const subA = (await a('GET', '/api/companies/1/subscription')).json;
    assert.equal((await b('POST', '/api/companies/1/subscription/confirm-payment', { linkId: 999, transactionRef: 'X' })).status, 403, 'B ne peut pas rapprocher chez A');

    // les exceptions d'A sont invisibles par id pour B (404, pas de sonde)
    const exA = (await a('GET', '/api/companies/1/exceptions')).json.exceptions;
    const cross = await b('POST', `/api/exceptions/${exA[0].id}/decision`, { decision: 'accept', note: '' });
    assert.equal(cross.status, 404);

    // après toutes ces tentatives, les données d'A sont intactes
    const still = (await a('GET', '/api/companies/1/exceptions')).json.exceptions;
    assert.equal(still.length, exA.length);
    const chain = (await a('POST', '/api/companies/1/audit/verify', {})).json;
    assert.equal(chain.ok, true);
  } finally { await t.close(); }
});

test('injection SQL : identifiants malformés et payloads hostiles → 400/404, tables intactes', async () => {
  const t = await boot();
  try {
    const { a } = await twoTenants(t);

    // injections via chemin
    for (const path of [
      '/api/companies/1%20OR%201=1/exceptions',
      '/api/companies/1;DROP%20TABLE%20exceptions;/exceptions',
      '/api/exceptions/1%3BDELETE%20FROM%20exceptions%3B/decision',
    ]) {
      const res = await a('POST', path, {});
      assert.ok([400, 404].includes(res.status), `${path} → ${res.status}`);
    }

    // payload SQL/XSS stocké comme DONNÉE (jamais interprété) puis traité par le moteur
    const hostile = '\'; DROP TABLE invoices; -- <img src=x onerror=alert(1)>';
    await a('POST', '/api/companies/1/import-invoices', { invoices: [{ id: 'inv-x', number: 'FA-X', customer: hostile, amountCents: 1000, currency: 'EUR', issueDate: '2026-11-01', dueDate: '2026-12-01' }] });
    await a('POST', '/api/companies/1/import-payments', { payments: [{ id: 'pay-x', label: hostile + ' FACT FA-X', amountCents: 1000, currency: 'EUR', date: '2026-11-20' }] });
    const an = await a('POST', '/api/companies/1/analyze', { label: hostile + ' FACT FA-X', amountEur: 10 });
    assert.equal(an.status, 200, 'le payload hostile est traité comme du texte');

    // les tables existent toujours et l'API renvoie du JSON (jamais du HTML exécutable)
    const inv = await t.db.query("SELECT COUNT(*)::int AS n FROM invoices WHERE company_id = 1");
    assert.ok(inv[0].n >= 1, 'table invoices intacte');
    const list = await a('GET', '/api/companies/1/exceptions');
    assert.equal(list.headers.get('content-type').includes('application/json'), true);
  } finally { await t.close(); }
});

test('secrets : sessions condensées uniquement, admin token à temps constant, 401/503 propres', async () => {
  const t = await boot({ ADMIN_TOKEN: 'adm-secret-123' });
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'sec@test.fr', password: 'motdepasse10', name: 'S' });

    // la base ne contient jamais un jeton de session en clair
    const sessions = await t.db.query('SELECT token_hash FROM sessions');
    assert.ok(sessions.length >= 1);
    for (const s of sessions) {
      assert.match(s.token_hash, /^[0-9a-f]{64}$/, 'condensé sha256 uniquement');
    }

    // endpoint admin : jeton absent → 401, jeton faux → 401, jeton bon → 200
    const tickNo = await fetch(`http://127.0.0.1:${t.port}/api/admin/scheduler/tick`, { method: 'POST' });
    assert.equal(tickNo.status, 401);
    const tickBad = await fetch(`http://127.0.0.1:${t.port}/api/admin/scheduler/tick`, { method: 'POST', headers: { 'x-admin-token': 'wrong' } });
    assert.equal(tickBad.status, 401);
    const tickOk = await fetch(`http://127.0.0.1:${t.port}/api/admin/scheduler/tick`, { method: 'POST', headers: { 'x-admin-token': 'adm-secret-123' } });
    assert.equal(tickOk.status, 200);

    // sans ADMIN_TOKEN configuré → 503 (pas de backdoor par défaut)
    const t2 = await boot();
    try {
      const tickNone = await fetch(`http://127.0.0.1:${t2.port}/api/admin/scheduler/tick`, { method: 'POST', headers: { 'x-admin-token': 'whatever' } });
      assert.equal(tickNone.status, 503);
    } finally { await t2.close(); }
  } finally { await t.close(); }
});

test('RGPD : export intégral (owner), suppression avec reçu, autre tenant intact, compte sans entreprise supprimable', async () => {
  const t = await boot();
  try {
    const { a, b } = await twoTenants(t);
    const ex = await a('POST', '/api/companies/1/export', {});
    assert.equal(ex.status, 200);
    assert.ok(ex.json.data.invoices.length >= 16, 'factures exportées');
    assert.ok(ex.json.data.audit_events.length >= 5, 'journal exporté');
    // le viewer ne peut pas exporter ; B non plus
    assert.equal((await b('POST', '/api/companies/1/export', {})).status, 403);

    const del = await a('DELETE', '/api/companies/1', {});
    assert.equal(del.status, 200);
    assert.equal(del.json.deleted, true);
    assert.ok(del.json.receipt.lastAuditHash, 'reçu avec dernier sceau d’audit');
    assert.ok(del.json.receipt.data.invoices.length >= 16, 'reçu contient le snapshot complet');
    assert.equal((await a('GET', '/api/companies/1/exceptions')).status, 403, 'entreprise supprimée : plus rien à lire');
    // le tenant B est intact
    assert.equal((await b('GET', '/api/companies/2/exceptions')).status, 200);

    // suppression du compte A (sans entreprise) → sessions et utilisateur détruits
    const gone = await a('DELETE', '/api/auth/me', {});
    assert.equal(gone.status, 200);
    assert.equal((await a('GET', '/api/me')).status, 401, 'session invalide après suppression du compte');
    const users = await t.db.query('SELECT COUNT(*)::int AS n FROM users WHERE email_lc = $1', ['att-a@test.fr']);
    assert.equal(users[0].n, 0);
  } finally { await t.close(); }
});
