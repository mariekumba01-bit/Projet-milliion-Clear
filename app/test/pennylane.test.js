'use strict';
// Pennylane réel (fournisseur local conforme) : OAuth code flow, state anti-CSRF,
// rotation stricte du refresh, sync avec mapping fidèle aux champs v2 vérifiés.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, startFakePennylane } from './helpers.js';

test('flow OAuth complet : authorize → callback → jetons chiffrés → sync → moteur analyse les données importées', async () => {
  const fake = await startFakePennylane();
  const t = await boot({
    PENNYLANE_CLIENT_ID: 'cid',
    PENNYLANE_CLIENT_SECRET: 'csecret',
    PENNYLANE_AUTH_URL: `http://127.0.0.1:${fake.port}/oauth/authorize`,
    PENNYLANE_TOKEN_URL: `http://127.0.0.1:${fake.port}/oauth/token`,
    PENNYLANE_API_URL: `http://127.0.0.1:${fake.port}/api/external/v2`,
    PENNYLANE_REDIRECT_BASE: 'http://127.0.0.1:31234', // le callback revient à NOTRE serveur (cookie de session)
    PORT_TEST: 31234,
  });
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'pl@test.fr', password: 'motdepasse10', name: 'PL' });
    await c('POST', '/api/companies', { name: 'Pennylane & Co' });
    const cookieHeader = c.cookieHeader();

    // 1) authorize → 302 vers le fournisseur avec state
    const auth = await fetch(`http://127.0.0.1:${t.port}/api/integrations/pennylane/authorize?company_id=1`, {
      headers: { cookie: cookieHeader }, redirect: 'manual',
    });
    assert.equal(auth.status, 302);
    const authorizeTarget = new URL(auth.headers.get('location'));
    assert.equal(authorizeTarget.pathname, '/oauth/authorize');
    assert.equal(authorizeTarget.searchParams.get('response_type'), 'code');
    assert.equal(authorizeTarget.searchParams.get('client_id'), 'cid');
    assert.equal(authorizeTarget.searchParams.get('scope'), 'customer_invoices:readonly transactions:readonly customers:readonly bank_accounts:readonly');
    const state = authorizeTarget.searchParams.get('state');
    assert.ok(state);

    // 2) le fournisseur redirige vers notre callback avec code+state (fl flow complet)
    const cb = await fetch(authorizeTarget, { redirect: 'manual' });
    assert.equal(cb.status, 302);
    const cbUrl = new URL(cb.headers.get('location'));
    assert.equal(cbUrl.pathname, '/api/integrations/pennylane/callback');
    const done = await fetch(cbUrl, { headers: { cookie: cookieHeader }, redirect: 'manual' });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location').includes('#integrations'), true);

    // state jetable : rejouer le callback → 400
    const replay = await fetch(cbUrl, { headers: { cookie: cookieHeader }, redirect: 'manual' });
    assert.equal(replay.status, 400, 'state anti-CSRF à usage unique');
    assert.ok(fake.state.tokenRequests.some((r) => r.grant_type === 'authorization_code' && r.code === 'code_good'));

    // 3) jetons chiffrés au repos : aucun token en clair en base
    const stored = await t.db.query('SELECT access_token_enc FROM pennylane_connections WHERE company_id = 1');
    assert.equal(stored.length, 1);
    assert.ok(!stored[0].access_token_enc.includes('at_fake'), 'jeton jamais stocké en clair');

    // 4) sync : mapping fidèle aux champs v2 (EUR amount, USD currency_amount, XOF écarté, statuts ouverts)
    const sync = await c('POST', '/api/integrations/pennylane/sync?company_id=1', {});
    assert.equal(sync.status, 200);
    assert.equal(sync.json.invoices.kept, 3);
    assert.equal(sync.json.invoices.skippedClosed, 1, 'facture paid → hors périmètre');
    assert.equal(sync.json.invoices.skippedCurrency, 1, 'XOF → écarté, jamais converti');
    assert.equal(sync.json.invoices.skippedShape, 1, 'invoice_number absent → écarté');
    assert.equal(sync.json.payments.kept, 2);
    const inv = await t.db.query("SELECT number, customer, amount_cents, currency FROM invoices WHERE company_id = 1 AND external_id = '101'");
    assert.equal(inv[0].customer, 'SARL BATIPLUS', 'nom résolu via le répertoire clients');
    assert.equal(inv[0].amount_cents, 240000);
    const invUsd = await t.db.query("SELECT amount_cents, currency FROM invoices WHERE external_id = '103'");
    assert.equal(invUsd[0].currency, 'USD');
    assert.equal(invUsd[0].amount_cents, 11880);

    // 5) le moteur tourne sur les données Pennylane réelles
    const an = await c('POST', '/api/companies/1/analyze', { label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0101', amountEur: 2400, currency: 'EUR' });
    assert.equal(an.status, 200);
    assert.equal(an.json.result.decision, 'proposal');
    assert.equal(an.json.result.classification, 'matched_exact');
  } finally { await t.close(); await fake.close(); }
});

test('rotation stricte du refresh : token expiré → 401 → refresh (rt_1) → retry OK ; ancien refresh invalidé', async () => {
  const fake = await startFakePennylane();
  const t = await boot({
    PENNYLANE_CLIENT_ID: 'cid', PENNYLANE_CLIENT_SECRET: 'csecret',
    PENNYLANE_AUTH_URL: `http://127.0.0.1:${fake.port}/oauth/authorize`,
    PENNYLANE_TOKEN_URL: `http://127.0.0.1:${fake.port}/oauth/token`,
    PENNYLANE_API_URL: `http://127.0.0.1:${fake.port}/api/external/v2`,
    PENNYLANE_REDIRECT_BASE: 'http://127.0.0.1:31235',
    PORT_TEST: 31235,
  });
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'rot@test.fr', password: 'motdepasse10', name: 'Rot' });
    await c('POST', '/api/companies', { name: 'Rotation' });
    const cookieHeader = c.cookieHeader();
    const auth = await fetch(`http://127.0.0.1:${t.port}/api/integrations/pennylane/authorize?company_id=1`, { headers: { cookie: cookieHeader }, redirect: 'manual' });
    const cb = await fetch(auth.headers.get('location'), { redirect: 'manual' });
    await fetch(cb.headers.get('location'), { headers: { cookie: cookieHeader }, redirect: 'manual' });

    // forcer l'expiration de l'access token → sync → 401 → refresh rotation → retry
    await t.db.query("UPDATE pennylane_connections SET access_expires_at = now() - interval '1 hour' WHERE company_id = 1");
    const sync = await c('POST', '/api/integrations/pennylane/sync?company_id=1', {});
    assert.equal(sync.status, 200, 'le retry post-rotation réussit');
    assert.equal(fake.state.refreshCount, 1);
    assert.ok(fake.state.tokenRequests.some((r) => r.grant_type === 'refresh_token' && r.refresh === 'rt_fake_1'), 'refresh effectué avec rt_1');
    const stored = await t.db.query('SELECT refresh_token_enc FROM pennylane_connections WHERE company_id = 1');
    assert.ok(stored[0].refresh_token_enc.length > 0, 'nouveau refresh chiffré persisté (rotation)');
  } finally { await t.close(); await fake.close(); }
});

test('sans identifiants partenaires : sync → 503 pennylane_not_configured, aucun appel réseau', async () => {
  const t = await boot();
  // config vivante réalignée (cache de module) : on retire les identifiants partenaires
  t.config.pennylane.clientId = '';
  t.config.pennylane.clientSecret = '';
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'nc@test.fr', password: 'motdepasse10', name: 'NC' });
    await c('POST', '/api/companies', { name: 'NC' });
    const sync = await c('POST', '/api/integrations/pennylane/sync?company_id=1', {});
    assert.equal(sync.status, 503);
    assert.equal(sync.json.error.code, 'pennylane_not_configured');
  } finally { await t.close(); }
});
