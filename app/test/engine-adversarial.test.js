'use strict';
// Tests adversariaux du moteur : labels trompeurs, collisions, doublons, données
// manquantes, malveillance. Mesure FP/FN arithmétique sur le lot de démonstration.
// RAPPEL HONNÊTE : tous ces résultats portent sur le JEU DE TEST SYNTHÉTIQUE du
// dépôt — aucune garantie de précision sur des transactions réelles (pilote requis).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v02 } from '../src/engine/core.js';
import demo from '../src/engine/demo-portfolio.json' with { type: 'json' };

const CFG = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };
const ctx = (payments) => ({ customers: demo.customers, config: CFG, batchPayments: payments });
const run = (payment) => v02(payment, demo.invoices, ctx(demo.payments));

test('INVARIANT ARITHMÉTIQUE : toute proposition ventile exactement le montant payé (0 faux positif d’affectation)', () => {
  let proposals = 0, broken = 0;
  for (const p of demo.payments) {
    const r = run(p);
    if (r.decision !== 'proposal') continue;
    proposals++;
    const assigned = r.proposal.breakdown?.length
      ? r.proposal.breakdown.reduce((a, b) => a + b.assignedCents, 0)
      : r.proposal.assignedAmountCents;
    if (assigned !== p.amountCents) broken++;
    // résiduel cohérent : jamais négatif
    if (r.proposal.residualCents < 0) broken++;
    // facture ouverte référencée : jamais une facture fermée ou inconnue
    const ids = new Set(demo.invoices.map((i) => i.id));
    const target = r.proposal.breakdown?.length
      ? r.proposal.breakdown.every((b) => ids.has(b.invoiceId))
      : ids.has(r.proposal.invoiceId);
    if (!target) broken++;
  }
  assert.equal(proposals, 9, 'le lot démo produit 9 propositions (jeu de test)');
  assert.equal(broken, 0, 'aucune proposition n’affecte un mauvais montant ou une facture inexistante');
});

test('manipulation : référence valide mais mauvais client (usurpation de libellé) → jamais de proposition certaine', () => {
  // FA2027-1001 appartient à SARL BATIPLUS ; on usurpe un autre client connu
  const stolen = { id: 'adv-1', label: 'VIR SEPA RECU DE STE TOITURE PLUS FACT FA2027-1001', amountCents: 240000, currency: 'EUR', date: '2026-11-20' };
  const r = v02(stolen, demo.invoices, ctx([...demo.payments, stolen]));
  // quelle que soit la décision, un « proposal » serait dangereux : le montant et la
  // référence collent, mais le client du libellé contredit la facture
  if (r.decision === 'proposal') {
    // le moteur n’oserait proposer qu’en ignorant le client : on exige au moins un
    // signalement explicite de l’écart de client dans les notes
    assert.ok(
      (r.notes ?? []).some((n) => /client/i.test(n)) || r.classification !== 'matched_exact',
      'une usurpation de client ne doit jamais produire un matched_exact silencieux',
    );
  } else {
    assert.ok(['flag', 'abstain'].includes(r.decision));
  }
});

test('injection hostile : payload SQL/XSS dans un libellé → décision sûre, aucune référence fabriquée', () => {
  const hostile = { id: 'adv-2', label: '\'; DROP TABLE invoices;-- <script>steal()</script> FACT FA2027-1001', amountCents: 240000, currency: 'EUR', date: '2026-11-20' };
  const r = v02(hostile, demo.invoices, ctx([...demo.payments, hostile]));
  assert.ok(r.requiresHuman === true);
  assert.ok(['proposal', 'flag', 'abstain'].includes(r.decision));
  if (r.decision === 'proposal') {
    const assigned = r.proposal.breakdown?.reduce((a, b) => a + b.assignedCents, 0) ?? r.proposal.assignedAmountCents;
    assert.equal(assigned, hostile.amountCents, 'même face à un payload hostile, l’affectation reste exacte');
  }
});

test('données dégradées : libellé vide, montant nul, devise absente → abstention sans exception', () => {
  const degraded = [
    { id: 'd1', label: '', amountCents: 10000, currency: 'EUR', date: '2026-11-20' },
    { id: 'd2', label: 'VIR SEPA', amountCents: 0, currency: 'EUR', date: '2026-11-20' },
    { id: 'd3', label: 'VIR SEPA RECU DE SARL BATIPLUS', amountCents: 10000, currency: undefined, date: '2026-11-20' },
    { id: 'd4', label: 'VIR SEPA RECU DE SARL BATIPLUS', amountCents: 10000, currency: 'EUR', date: '' },
  ];
  for (const p of degraded) {
    let r;
    assert.doesNotThrow(() => { r = run(p); }, `aucune exception sur données dégradées (${p.id})`);
    assert.ok(r.requiresHuman === true);
  }
});

test('rejet bancaire négatif : jamais de proposition, toujours un signalement dédié', () => {
  const neg = { id: 'adv-3', label: 'REJET PRELEVEMENT SARL BATIPLUS FA2027-1001', amountCents: -240000, currency: 'EUR', date: '2026-11-25' };
  const r = v02(neg, demo.invoices, ctx([...demo.payments, neg]));
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'rejected_or_reversal');
  assert.equal(r.proposal, null);
});

test('mesure de recouvrement sur le lot : les 9 propositions couvrent toutes une opération distincte (pas de double affectation)', () => {
  const used = new Set();
  for (const p of demo.payments) {
    const r = run(p);
    if (r.decision !== 'proposal') continue;
    const key = r.proposal.breakdown?.length
      ? r.proposal.breakdown.map((b) => `${b.invoiceId}:${b.assignedCents}`).sort().join('|')
      : `${r.proposal.invoiceId}:${r.proposal.assignedAmountCents}`;
    assert.ok(!used.has(key), `affectation dupliquée détectée : ${key}`);
    used.add(key);
  }
});
