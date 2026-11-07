'use strict';
// Sécurité des webhooks SasPay : signature à temps constant, fenêtre d'âge,
// idempotence par id d'événement, ambiguïtés jamais résolues par devinette.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { boot, client, postSignedWebhook } from './helpers.js';
import { verifyWebhookSignature } from '../src/integrations/saspay.js';

test('vérification pure : signature valide, falsifiée, expirée, mauvais secret', () => {
  const raw = JSON.stringify({ event: 'webhook.test', data: {} });
  const ts = Math.floor(Date.now() / 1000);
  const mk = (secret, t) => createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const good = mk('whsec_test_2026', ts);
  assert.deepEqual(verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026' }), { ok: true, value: true });
  assert.equal(verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'autre_secret' }).ok, false);
  // corps falsifié : même timestamp, signature de l'original → refus
  assert.equal(verifyWebhookSignature({ rawBody: raw + ' ', timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026' }).ok, false);
  // rejoué 10 minutes plus tard → refus d'âge
  const old = verifyWebhookSignature({ rawBody: raw, timestampHeader: String(ts), signatureHeader: good, secret: 'whsec_test_2026', nowUnixSeconds: ts + 601 });
  assert.equal(old.ok, false);
  assert.ok(old.reason.includes('tolérance'));
});

test('suite HTTP : webhook accepté, signé invalide refusé 401, même événement rejoué → duplicate', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'wh@test.fr', password: 'motdepasse10', name: 'Wh' });
    await c('POST', '/api/companies', { name: 'WH Société' });
    await c('POST', '/api/companies/1/subscription', { plan: 'pro' });

    const ok = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-1', amount: '97500.00', currency: 'XOF', reference: 'ref-1' } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.matched, true);

    const replay = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-1', amount: '97500.00' } });
    assert.equal(replay.json.duplicate, true, 'idempotence : le même événement n’est jamais traité deux fois');

    const bad = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-2', amount: '97500.00' } }, { sigOverride: 'deadbeef'.repeat(8) });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'invalid_signature');

    const tampered = await postSignedWebhook(
      t.port,
      { event: 'transaction.success', data: { id: 'txn-3', amount: '1.00' } },
      { sendBody: JSON.stringify({ event: 'transaction.success', data: { id: 'txn-3', amount: '999999.00' } }) },
    );
    assert.equal(tampered.status, 401, 'le corps modifié après signature rompt la vérification');

    const expired = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-4', amount: '97500.00' } }, { tsOffset: -601 });
    assert.equal(expired.status, 401, 'webhook intercepté et rejoué 10 min après → refus d’âge');

    const sub = await c('GET', '/api/companies/1/subscription');
    assert.equal(sub.json.status, 'active');
    assert.equal(sub.json.links.filter((l) => l.status === 'paid').length, 1);
  } finally { await t.close(); }
});

test('ambiguïté : deux entreprises au même palier, même montant → jamais d’affectation automatique', async () => {
  const t = await boot();
  try {
    const a = client(t.port);
    await a('POST', '/api/auth/register', { email: 'a2@test.fr', password: 'motdepasse10', name: 'A' });
    await a('POST', '/api/companies', { name: 'A' });
    await a('POST', '/api/companies/1/subscription', { plan: 'starter' });
    await a('POST', '/api/auth/logout', {});
    await a('POST', '/api/auth/register', { email: 'b2@test.fr', password: 'motdepasse10', name: 'B' });
    await a('POST', '/api/companies', { name: 'B' });
    await a('POST', '/api/companies/2/subscription', { plan: 'starter' });

    // 32 000 FCFA ouverts chez A et B simultanément → paiement de 32 000 : arbitrage humain
    const w = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-amb', amount: '32000.00' } });
    assert.equal(w.json.matched, false);
    assert.ok(w.json.reason.includes('arbitrage humain'));

    // le paiement est archivé pour réconciliation, aucun lien n'est marqué payé
    const events = await t.db.query('SELECT COUNT(*)::int AS n FROM saspay_events');
    assert.equal(events[0].n, 1);
    const links = await t.db.query("SELECT COUNT(*)::int AS n FROM payment_links WHERE status = 'paid'");
    assert.equal(links[0].n, 0);
  } finally { await t.close(); }
});

test('webhook sans secret configuré → 503 refus explicite (jamais d’acceptation non vérifiée)', async () => {
  const t = await boot();
  // config.js est mis en cache par import : on désactive le secret directement sur l'objet vivant
  t.config.saspay.webhookSecret = '';
  try {
    const res = await fetch(`http://127.0.0.1:${t.port}/api/webhooks/saspay`, { method: 'POST', body: JSON.stringify({ event: 'webhook.test', data: {} }) });
    assert.equal(res.status, 503);
  } finally { await t.close(); }
});
