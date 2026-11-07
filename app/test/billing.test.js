'use strict';
// Cycle de vie abonnement : souscription → paiement → active ; J7 rappel ;
// J21 suspension → moteur bloqué (402) → paiement tardif → réactivation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, client, postSignedWebhook } from './helpers.js';
import { schedulerTick, PLANS, monthKey, dueDateFor } from '../src/billing.js';
import { tierToFcfa } from '../src/integrations/saspay.js';

test('paliers : FCFA à parité fixe, arrondis au 500 (32 000 / 97 500 / 261 500)', () => {
  assert.equal(tierToFcfa(PLANS.starter.monthlyEurCents / 100).rounded, 32000);
  assert.equal(tierToFcfa(PLANS.pro.monthlyEurCents / 100).rounded, 97500);
  assert.equal(tierToFcfa(PLANS.cabinet.monthlyEurCents / 100).rounded, 261500);
});

test('souscription sans clé SasPay → lien manuel 97 500 FCFA ; paiement → active ; J21 sans payer → suspendu + moteur 402', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'bill@test.fr', password: 'motdepasse10', name: 'Bill' });
    await c('POST', '/api/companies', { name: 'Facture & Fils' });
    await c('POST', '/api/companies/1/seed-demo', {});

    // moteur accessible avant abonnement (modèle pilote) — aucune suspension tant que pas J21
    const pre = await c('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
    assert.equal(pre.status, 200);

    const sub = await c('POST', '/api/companies/1/subscription', { plan: 'pro' });
    assert.equal(sub.status, 200);
    assert.equal(sub.json.subscription.status, 'pending_payment');
    assert.equal(sub.json.link.mode, 'manual', 'sans SASPAY_API_KEY : lien manuel honnête, jamais simulé');
    assert.equal(sub.json.link.amount_fcfa, 97500);
    assert.equal(String(sub.json.subscription.due_date).includes('-21'), true, 'échéance J21 du mois de période');

    // J7 : rappel scellé au journal
    const now = new Date();
    const mid = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 7, 12));
    const tick7 = await schedulerTick(t.db, t.config, mid);
    assert.ok(tick7.actions.some((a) => a.action === 'reminder'));
    const audit7 = await t.db.query("SELECT payload FROM audit_events WHERE kind = 'billing.reminder'");
    assert.equal(audit7.length, 1);

    // paiement réel (webhook signé, montant du lien) → active
    const pay = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-ok', amount: '97500.00' } });
    assert.equal(pay.json.matched, true);
    const after = await c('GET', '/api/companies/1/subscription');
    assert.equal(after.json.status, 'active');
    assert.equal(after.json.links[0].status, 'paid');

    // J21 du mois suivant sans paiement → suspension
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 21, 12));
    const tick21 = await schedulerTick(t.db, t.config, next);
    assert.ok(tick21.actions.some((a) => a.action === 'suspended'));
    const blocked = await c('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
    assert.equal(blocked.status, 402);
    assert.equal(blocked.json.error.code, 'subscription_suspended');

    // paiement tardif du lien suspendu → réactivation (le webhook marque le lien payé → active)
    const pay2 = await postSignedWebhook(t.port, { event: 'transaction.success', data: { id: 'txn-late', amount: '97500.00' } });
    assert.equal(pay2.json.matched, true);
    const unblocked = await c('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
    assert.equal(unblocked.status, 200);
    const reactivated = await c('GET', '/api/companies/1/subscription');
    assert.equal(reactivated.json.status, 'active');
  } finally { await t.close(); }
});

test('décisions humaines intouchables : la ré-analyse ne re-traite pas les exceptions arbitées', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'dec@test.fr', password: 'motdepasse10', name: 'Dec' });
    await c('POST', '/api/companies', { name: 'D' });
    await c('POST', '/api/companies/1/seed-demo', {});
    const list = (await c('GET', '/api/companies/1/exceptions')).json.exceptions;
    const one = list.find((e) => e.decision === 'proposal');
    const res = await c('POST', `/api/exceptions/${one.id}/decision`, { decision: 'reject', note: 'hors périmètre' });
    assert.equal(res.json.status, 'rejected');
    const again = await c('POST', `/api/exceptions/${one.id}/decision`, { decision: 'accept', note: '' });
    assert.equal(again.status, 409, 'décision finale : jamais modifiable par le moteur');
    await c('POST', '/api/companies/1/reanalyze', {});
    const after = (await c('GET', '/api/companies/1/exceptions?status=rejected')).json;
    assert.equal(after.exceptions.filter((e) => e.id === one.id).length, 1, 'le rejet survit à la ré-analyse');
  } finally { await t.close(); }
});

test('chaîne d’audit : genesis → N événements, vérification OK, rupture détectée si falsification SQL', async () => {
  const t = await boot();
  try {
    const c = client(t.port);
    await c('POST', '/api/auth/register', { email: 'audit@test.fr', password: 'motdepasse10', name: 'Aud' });
    await c('POST', '/api/companies', { name: 'Aud & Co' });
    await c('POST', '/api/companies/1/seed-demo', {});
    await c('POST', '/api/companies/1/audit/verify', {});
    let v = (await c('POST', '/api/companies/1/audit/verify', {})).json;
    assert.equal(v.ok, true);
    assert.ok(v.checked >= 2);

    // falsification directe en base (simule une main malveillante sur PostgreSQL)
    await t.db.query("UPDATE audit_events SET payload = jsonb_set(payload, '{tampered}', 'true') WHERE company_id = 1 AND seq = 1");
    v = (await c('POST', '/api/companies/1/audit/verify', {})).json;
    assert.equal(v.ok, false);
    assert.equal(v.brokenAt, 1);
  } finally { await t.close(); }
});

test('isolation tenants : exceptions, audit et décisions cloisonnés par entreprise', async () => {
  const t = await boot();
  try {
    const a = client(t.port);
    await a('POST', '/api/auth/register', { email: 't1@test.fr', password: 'motdepasse10', name: 'T1' });
    await a('POST', '/api/companies', { name: 'Tenant 1' });
    await a('POST', '/api/companies/1/seed-demo', {});
    // captures faites pendant la session T1, avant tout changement de session
    const e1 = (await a('GET', '/api/companies/1/exceptions')).json.exceptions;
    await a('POST', '/api/auth/logout', {});
    await a('POST', '/api/auth/register', { email: 't2@test.fr', password: 'motdepasse10', name: 'T2' });
    await a('POST', '/api/companies', { name: 'Tenant 2' });
    await a('POST', '/api/companies/2/seed-demo', {});

    // les deux tenants ont leurs propres exceptions (portefeuille démo identique)
    const e2 = (await a('GET', '/api/companies/2/exceptions')).json.exceptions;
    assert.ok(e1.length > 0 && e2.length > 0);
    assert.notEqual(e1[0].id, e2[0].id, 'ids séparés : aucune vue croisée');

    // T2 ne peut ni décider ni lire les exceptions de T1
    const cross = await a('POST', `/api/exceptions/${e1[0].id}/decision`, { decision: 'accept', note: '' });
    assert.equal(cross.status, 404, 'exception d’un autre tenant = inexistante pour moi');
    const audit2 = (await a('GET', '/api/companies/1/audit')).json;
    assert.equal(audit2.error.code, 'not_member', 'audit de T1 inaccessible pour T2');
  } finally { await t.close(); }
});
