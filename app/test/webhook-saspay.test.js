'use strict';
// Sécurité des webhooks SasPay :
//  • ordre des opérations : signature AVANT toute écriture en base (régression d'empoisonnement) ;
//  • réconciliation par identifiants fournisseur, jamais sur le seul montant ;
//  • mode manuel → « candidate » + rapprochement humain, jamais d'activation automatique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { boot, client, postSignedWebhook, startFakeSaspay } from './helpers.js';
import { verifyWebhookSignature } from '../src/integrations/saspay.js';

const SIGN = (secret, raw, ts) => createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');

test('vérification pure : signature valide, falsifiée, expirée, mauvais secret', () => {
  const raw = JSON.stringify({ event: 'webhook.test', data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const good = SIGN('whsec_test_2026', raw, ts);
  assert.deepEqual(verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026' }), { ok: true, value: true });
  assert.equal(verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'autre_secret' }).ok, false);
  assert.equal(verifyWebhookSignature({ rawBody: raw + ' ', timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026' }).ok, false);
  const old = verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026', nowUnixSeconds: ts + 601 });
  assert.equal(old.ok, false);
  assert.ok(old.reason.includes('tolérance'));
});

test('RÉGRESSION EMPOISONNEMENT : un faux webhook ne réserve jamais l’id d’un événement légitime', async () => {
  const fake = await startFakeSaspay();
  const t = await boot({
    SASPAY_API_KEY: 'sk_test',
    SASPAY_BASE_URL: `http://127.0.0.1:${fake.port}`,
  });
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'poison@test.fr', password: 'motdepasse10', name: 'P' });
    await c('POST', '/api/companies', { name: 'Poison & Co' });
    const sub = (await c('POST', '/api/companies/1/subscription', { plan: 'pro' })).json;
    const legitTxn = 'txn-legit-1';
    fake.addTransaction(sub.link.saspay_id, { id: legitTxn, status: 'success', amount: '97500.00', currency: 'XOF' });

    // 1) FRAUDE : même identifiant d'événement, signature invalide, montant falsifié
    const fraudBody = JSON.stringify({ event: 'transaction.success', data: { id: legitTxn, amount: '1.00' } });
    const ts = Math.floor(Date.now() / 1000);
    const fraud = await fetch(`http://127.0.0.1:${t.port}/api/webhooks/saspay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': SIGN('whsec_test_2026', '{"event":"x"}', ts), 'X-Webhook-Timestamp': String(ts) },
      body: fraudBody,
    });
    assert.equal(fraud.status, 401);

    // 2) RIEN ne doit être inscrit en base : la signature est vérifiée AVANT le stockage
    const stored = await t.db.query('SELECT COUNT(*)::int AS n FROM saspay_events');
    assert.equal(stored[0].n, 0, 'aucun webhook invalide ne touche la base');

    // 3) L'ÉVÉNEMENT LÉGITIME, avec le même id, doit être traité normalement
    const legit = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: legitTxn, amount: '97500.00', currency: 'XOF', status: 'success' } });
    assert.equal(legit.json.matched, true, 'l’événement légitime n’a pas été bloqué par la fraude');
    const subAfter = (await c('GET', '/api/companies/1/subscription')).json;
    assert.equal(subAfter.status, 'active');
    assert.equal(subAfter.links[0].paid_transaction_ref, legitTxn);

    // 4) rejouer l'événement légitime → duplicate (idempotence), sans effet de bord
    const replay = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: legitTxn, amount: '97500.00' } });
    assert.equal(replay.json.duplicate, true);
  } finally { await t.close(); await fake.close(); }
});

test('réconciliation fournisseur : collision de montants entre deux entreprises résolue par l’id de transaction', async () => {
  const fake = await startFakeSaspay();
  const t = await boot({
    SASPAY_API_KEY: 'sk_test',
    SASPAY_BASE_URL: `http://127.0.0.1:${fake.port}`,
  });
  try {
    // deux clients distincts = deux vrais utilisateurs, jamais de session partagée
    const c1 = client(t.port);
    await c1('POST', '/api/auth/register', { email: 'col1@test.fr', password: 'motdepasse10', name: 'C1' });
    await c1('POST', '/api/companies', { name: 'Collision 1' });
    await c1('POST', '/api/companies/1/subscription', { plan: 'starter' });
    const s1 = (await c1('GET', '/api/companies/1/subscription')).json;

    const c2 = client(t.port);
    await c2('POST', '/api/auth/register', { email: 'col2@test.fr', password: 'motdepasse10', name: 'C2' });
    await c2('POST', '/api/companies', { name: 'Collision 2' });
    await c2('POST', '/api/companies/2/subscription', { plan: 'starter' });
    const s2 = (await c2('GET', '/api/companies/2/subscription')).json;

    // deux liens au MÊME montant (32 000 FCFA) chez deux tenants différents
    assert.equal(s1.links[0].amount_fcfa, 32000);
    assert.equal(s2.links[0].amount_fcfa, 32000);

    // la transaction n'existe QUE dans le lien de l'entreprise 2 (vérité fournisseur)
    fake.addTransaction(s2.links[0].saspay_id, { id: 'txn-coll', status: 'success', amount: '32000.00', currency: 'XOF' });
    const w = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-coll', amount: '32000.00', currency: 'XOF', status: 'success' } });
    assert.equal(w.json.matched, true);
    assert.equal(w.json.companyId, 2, 'le bon tenant est activé par l’identifiant fournisseur, pas par le montant');

    const one = (await c1('GET', '/api/companies/1/subscription')).json;
    const two = (await c2('GET', '/api/companies/2/subscription')).json;
    assert.equal(one.status, 'pending_payment', 'le tenant sans transaction réelle reste impayé');
    assert.equal(two.status, 'active');
    assert.equal(one.links.filter((l) => l.status === 'paid').length, 0);

    // transaction inconnue des liens candidats → jamais d'activation
    const ghost = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-ghost', amount: '32000.00', currency: 'XOF' } });
    assert.equal(ghost.json.matched, false);
    assert.ok(ghost.json.reason.includes('rapprochement manuel'));
  } finally { await t.close(); await fake.close(); }
});

test('mode manuel : webhook cohérent → « candidate » + rapprochement HUMAIN ; jamais d’activation automatique', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'man@test.fr', password: 'motdepasse10', name: 'M' });
    await c('POST', '/api/companies', { name: 'Manuel SA' });
    await c('POST', '/api/companies/1/subscription', { plan: 'cabinet' });

    const w = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-man', amount: '261500.00', currency: 'XOF' } });
    assert.equal(w.json.matched, false, 'aucune activation automatique sans vérification fournisseur');
    assert.equal(w.json.manual, true);
    const mid = (await c('GET', '/api/companies/1/subscription')).json;
    assert.equal(mid.status, 'pending_payment');
    assert.equal(mid.links[0].status, 'candidate');

    // devise étrangère → refus explicite
    const wrongCur = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-eur', amount: '261500.00', currency: 'EUR' } });
    assert.equal(wrongCur.json.matched, false);
    assert.ok(wrongCur.json.reason.includes('devise'));

    // le viewer ne peut pas rapprocher ; l'owner confirme avec la référence + note
    const v = client(t.port);
    await v('POST', '/api/auth/register', { email: 'manviewer@test.fr', password: 'motdepasse10', name: 'V' });
    await t.db.query("INSERT INTO memberships (company_id, user_id, role) VALUES (1, 2, 'viewer')");
    const denied = await v('POST', '/api/companies/1/subscription/confirm-payment', { linkId: mid.links[0].id, transactionRef: 'SP-MAN-1', note: '' });
    assert.equal(denied.status, 403);

    const ok = await c('POST', '/api/companies/1/subscription/confirm-payment', { linkId: mid.links[0].id, transactionRef: 'SP-MAN-1', note: 'vérifié sur le tableau de bord SasPay' });
    assert.equal(ok.status, 200);
    const active = (await c('GET', '/api/companies/1/subscription')).json;
    assert.equal(active.status, 'active');

    // la même référence de transaction ne peut rien payer d'autre (antifraude)
    await c('POST', '/api/companies/1/subscription', { plan: 'starter' });
    const w2 = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'SP-MAN-1', amount: '32000.00', currency: 'XOF' } });
    assert.equal(w2.json.matched, false);
    assert.ok(w2.json.reason.includes('déjà consommée'));
  } finally { await t.close(); }
});

test('événements hors catalogue / statuts non réussis / corps illisible → refus sans écriture', async () => {
  const t = await boot();
  try {
    const before = (await t.db.query('SELECT COUNT(*)::int AS n FROM saspay_events'))[0].n;
    const bad1 = await postSignedWebhook(t.port, { event: 'transaction.exploded', data: {} });
    assert.equal(bad1.status, 401, 'événement hors catalogue v1.0.0 → refus (pas de supposition)');
    const bad2 = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'x', status: 'pending', amount: '97500.00' } });
    assert.equal(bad2.json.matched, false, 'statut non réussi → aucune activation');
    const bad3 = await postSignedWebhook(t.port, { event: 'webhook.test', data: {} });
    assert.equal(bad3.json.accepted, true, 'webhook.test archivé sans action');
    const after = (await t.db.query('SELECT COUNT(*)::int AS n FROM saspay_events'))[0].n;
    assert.ok(after - before >= 1, 'les événements VALIDES sont archivés pour audit');
  } finally { await t.close(); }
});

test('webhook sans secret configuré → 503 refus explicite (jamais d’acceptation non vérifiée)', async () => {
  const t = await boot();
  t.config.saspay.webhookSecret = '';
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/api/webhooks/saspay`, { method: 'POST', body: JSON.stringify({ event: 'webhook.test', data: {} }) });
    assert.equal(res.status, 503);
  } finally { await t.close(); }
});

test('événements reçus dans le désordre (failed puis success) : l’ordre ne crée ni blocage ni activation anticipée', async () => {
  const fake = await startFakeSaspay();
  const t = await boot({ SASPAY_API_KEY: 'sk_test', SASPAY_BASE_URL: `http://127.0.0.1:${fake.port}` });
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'ord@test.fr', password: 'motdepasse10', name: 'O' });
    await c('POST', '/api/companies', { name: 'Désordre' });
    const sub = (await c('POST', '/api/companies/1/subscription', { plan: 'pro' })).json;
    const link = sub.link.saspay_id;
    const fail = await postSignedWebhook(t.port, { event: 'transaction.failed', data: { id: 'txn-ord', amount: '97500.00' } });
    assert.equal(fail.json.accepted, true, 'failed archivé sans effet');
    // le success n'est PAS encore dans les transactions du lien (fournisseur pas à jour) → rien
    const early = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-ord', amount: '97500.00', currency: 'XOF' } });
    assert.equal(early.json.matched, false, 'sans confirmation fournisseur, rien ne s’active');
    // le fournisseur rattrape : la transaction apparaît dans le lien → l’événement suivant réussit
    fake.addTransaction(link, { id: 'txn-ord-2', status: 'success', amount: '97500.00', currency: 'XOF' });
    const late = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-ord-2', amount: '97500.00', currency: 'XOF' } });
    assert.equal(late.json.matched, true);
  } finally { await t.close(); await fake.close(); }
});
