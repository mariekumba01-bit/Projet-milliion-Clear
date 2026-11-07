'use strict';
// Moteur pur (port fidèle) : mêmes verdicts que le banc d'essai de référence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v02 } from '../src/engine/core.js';
import demo from '../src/engine/demo-portfolio.json' with { type: 'json' };

const CFG = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };

test('lot démo : 9 propositions / 7 signalements / 5 abstentions (identique au banc de référence)', () => {
  const counts = { proposal: 0, flag: 0, abstain: 0 };
  for (const p of demo.payments) {
    const ctx = { customers: demo.customers, config: CFG, batchPayments: demo.payments };
    counts[v02(p, demo.invoices, ctx).decision]++;
  }
  assert.deepEqual(counts, { proposal: 9, flag: 7, abstain: 5 });
});

test('invariant absolu : requiresHuman=true et llmCalls=0, toujours', () => {
  for (const p of demo.payments) {
    const r = v02(p, demo.invoices, { customers: demo.customers, config: CFG, batchPayments: demo.payments });
    assert.equal(r.requiresHuman, true);
    assert.equal(r.llmCalls, 0);
    if (r.decision === 'proposal') assert.ok(r.proposal.explanation.length > 5);
  }
});

test('jumeaux : deux paiements identiques → flag ambiguous, jamais d’affectation', () => {
  const twins = demo.payments.filter((p) => p.label === 'VIR RECU GAUTHIER ET FILS');
  assert.equal(twins.length, 2, 'exactement deux virements identiques (le « ACOMPTE » à 1 440 € est un autre cas)');
  for (const p of twins) {
    const r = v02(p, demo.invoices, { customers: demo.customers, config: CFG, batchPayments: demo.payments });
    assert.equal(r.decision, 'flag');
    assert.equal(r.classification, 'ambiguous');
    assert.equal(r.proposal, null);
  }
});

test('virement groupé au prorata : ventilation 2 factures, résiduels cohérents', () => {
  const p = demo.payments.find((x) => x.label.includes('DELMAS REGLEMENT FACT FA2027-1002'));
  const r = v02(p, demo.invoices, { customers: demo.customers, config: CFG, batchPayments: demo.payments });
  assert.equal(r.decision, 'proposal');
  assert.equal(r.classification, 'multi_reference_grouped');
  assert.equal(r.proposal.breakdown.length, 2);
  const assigned = r.proposal.breakdown.reduce((a, b) => a + b.assignedCents, 0);
  assert.equal(assigned, p.amountCents);
});

test('devise étrangère : rapprochement bloqué (currency_mismatch), aucune écriture', () => {
  const usd = demo.payments.find((x) => x.currency === 'USD');
  const r = v02(usd, demo.invoices, { customers: demo.customers, config: CFG, batchPayments: demo.payments });
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'currency_mismatch');
});
