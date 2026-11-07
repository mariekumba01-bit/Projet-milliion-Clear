'use strict';
// Parcours complet « comme un vrai utilisateur » — de l'inscription à la suspension,
// en HTTP réel contre un serveur ClearMatch App réel (PostgreSQL embarqué pglite).
// Exporté pour le test E2E ; exécutable seul : node scripts/e2e-journey.mjs
process.env.NODE_ENV = 'test';
process.env.APP_SECRET_KEY ||= 'a'.repeat(32);
process.env.SASPAY_WEBHOOK_SECRET ||= 'whsec_test_2026';
process.env.BILLING_ENFORCE ||= '1';

const step = (n, title, extra = '') => console.log(`  ${String(n).padStart(2, '0')}. ${title}${extra ? ` — ${extra}` : ''}`);

export async function runJourney() {
  const { initPglite, Db } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { config } = await import('../src/config.js');
  await initPglite();
  const db = new Db('pglite::memory:');
  await db.migrate();
  const server = createApp({ db, cfg: config });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await journeySteps(port, db, config);
  } finally {
    await new Promise((r) => server.close(r));
    await db.close();
  }
}

async function journeySteps(port, db, config) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json', 'x-clearmatch-csrf': '1' } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* 302 */ }
    return { status: res.status, json };
  };
  const signedWebhook = async (obj) => {
    const { createHmac } = await import('node:crypto');
    const raw = JSON.stringify(obj);
    const ts = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', 'whsec_test_2026').update(`${ts}.${raw}`).digest('hex');
    const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/saspay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sig, 'X-Webhook-Timestamp': String(ts) },
      body: raw,
    });
    return res.json();
  };

  const out = {};

  // 1-2 : compte + entreprise
  step(1, 'Inscription (marie@cabinet-kumba.fr)');
  assertEq((await call('POST', '/api/auth/register', { email: 'marie@cabinet-kumba.fr', password: 'MotDePasse2026!', name: 'Marie Kumba' })).status, 201);
  step(2, 'Création de l’entreprise (espace isolé)');
  assertEq((await call('POST', '/api/companies', { name: 'Cabinet Kumba & Associés' })).status, 201);

  // 3 : portefeuille de démonstration + analyse du lot
  step(3, 'Chargement du portefeuille démo (16 factures / 21 opérations) et analyse');
  const seed = await call('POST', '/api/companies/1/seed-demo', {});
  assertEq(seed.status, 200);
  out.seed = seed.json.counts;
  step(3, 'verdicts du lot', `${out.seed.proposal} propositions / ${out.seed.flag} alertes / ${out.seed.abstain} abstentions`);

  // 4 : analyse à la volée d'un virement groupé
  step(4, 'Analyse d’un libellé à la volée (virement groupé Delmas, 138 €)');
  const an = await call('POST', '/api/companies/1/analyze', {
    label: 'VIR SEPA RECU DE MEUBLES DELMAS REGLEMENT FACT FA2027-1002 + FA2027-1005', amountEur: 138,
  });
  assertEq(an.status, 200);
  out.live = { decision: an.json.result.decision, classification: an.json.result.classification };
  step(4, 'verdict', `${out.live.decision} · ${out.live.classification}`);

  // 5-6 : validation humaine d'une proposition → écriture proposée
  step(5, 'Liste des exceptions (décision humaine requise)');
  const list = (await call('GET', '/api/companies/1/exceptions')).json.exceptions;
  const target = list.find((e) => e.decision === 'proposal');
  out.exceptions = list.length;
  step(5, 'exceptions en attente', `${list.length}`);
  step(6, `Validation humaine de l’exception №${target.id} (accept)`);
  const dec = await call('POST', `/api/exceptions/${target.id}/decision`, { decision: 'accept', note: 'preuves vérifiées par Marie' });
  assertEq(dec.status, 200);
  out.entry = dec.json.entry?.lines ?? null;
  step(6, 'écriture proposée générée', out.entry ? `${out.entry.length} lignes (411/512), jamais postée` : '—');

  // 7 : audit chaîné
  step(7, 'Journal d’audit : vérification de la chaîne SHA-256');
  const ver = await call('POST', '/api/companies/1/audit/verify', {});
  assertEq(ver.json.ok, true);
  out.auditChecked = ver.json.checked;
  step(7, 'chaîne intègre', `${ver.json.checked} sceaux recalculés`);

  // 8 : abonnement Pro
  step(8, 'Souscription Pro (149 € ≈ 97 500 FCFA/mois, lien manuel sans clé SasPay)');
  const sub = await call('POST', '/api/companies/1/subscription', { plan: 'pro' });
  assertEq(sub.status, 200);
  out.link = { mode: sub.json.link.mode, amountFcfa: sub.json.link.amount_fcfa, due: sub.json.subscription.due_date };
  step(8, 'lien du mois créé', `${out.link.amountFcfa} FCFA · mode ${out.link.mode} · échéance ${out.link.due}`);

  // 9 : paiement SasPay réel (webhook signé) → actif
  step(9, 'Paiement du client via SasPay (webhook transaction.success signé HMAC)');
  const pay = await signedWebhook({ event: 'transaction.success', data: { id: 'txn-e2e-1', amount: '97500.00', currency: 'XOF', reference: 'SP-E2E-1' } });
  assertEq(pay.matched, true);
  const active = (await call('GET', '/api/companies/1/subscription')).json;
  assertEq(active.status, 'active');
  step(9, 'abonnement actif', 'lien marqué payé, période courant mois');

  // 10 : mois suivant sans paiement → J21 → suspension → moteur bloqué (402)
  step(10, 'Mois suivant sans paiement : tick J21 (rappel J7 déjà passé) → suspension');
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 21, 12));
  const { schedulerTick } = await import('../src/billing.js');
  const tick = await schedulerTick(db, config, nextMonth);
  assertEq(tick.actions.some((a) => a.action === 'suspended'), true);
  const blocked = await call('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
  assertEq(blocked.status, 402);
  step(10, 'accès suspendu', `analyse → HTTP ${blocked.status} (${blocked.json.error.code})`);

  // 11 : paiement tardif → réactivation
  step(11, 'Régularisation : paiement tardif du lien du mois → réactivation');
  const late = await signedWebhook({ event: 'transaction.success', data: { id: 'txn-e2e-2', amount: '97500.00', reference: 'SP-E2E-2' } });
  assertEq(late.matched, true);
  const revived = (await call('GET', '/api/companies/1/subscription')).json.status;
  assertEq(revived, 'active');
  const ok = await call('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
  assertEq(ok.status, 200);
  step(11, 'accès rétabli', 'analyse → HTTP 200');

  // 12 : audit final
  step(12, 'Chaîne d’audit finale (aucune altération sur tout le parcours)');
  const final = await call('POST', '/api/companies/1/audit/verify', {});
  assertEq(final.json.ok, true);
  out.auditOk = final.json.ok;
  out.auditFinal = final.json.checked;
  step(12, 'chaîne intègre', `${final.json.checked} événements scellés`);

  return out;
}

function assertEq(actual, expected) {
  if (actual !== expected) {
    throw new Error(`parcours rompu : attendu ${JSON.stringify(expected)}, obtenu ${JSON.stringify(actual)}`);
  }
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  console.log('PARCOURS UTILISATEUR COMPLET — ClearMatch App (HTTP réel)');
  runJourney()
    .then((out) => { console.log('\n✓ PARCOURS COMPLET RÉUSSI —', JSON.stringify(out, null, 1)); })
    .catch((e) => { console.error('\n✗ ÉCHEC :', e.message); process.exit(1); });
}
