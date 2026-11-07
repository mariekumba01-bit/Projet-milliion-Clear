// ─────────────────────────────────────────────────────────────────────────────
// Tests du connecteur Pennylane — traduction fixtures → domaine, sans réseau.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { translatePennylane, type PennylaneWorld } from '../src/connector-pennylane.ts';
import { createEngine as createV02 } from '../src/engine-v02.ts';
import type { EngineConfig } from '../src/types.ts';

const config: EngineConfig = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };

const world: PennylaneWorld = {
  invoices: [
    { id: 'pl-inv-001', invoice_number: 'FA2027-1001', customer_name: 'SARL BATIPLUS', customer_reference: 'CDE-8842', total: 240000, currency: 'EUR', issuance_date: '2027-01-05', due_date: '2027-01-20', status: 'open' },
    { id: 'pl-inv-002', invoice_number: 'FA2027-1002', customer_name: 'Meubles Delmas', customer_reference: null, total: 156000, currency: 'EUR', issuance_date: '2027-01-08', due_date: '2027-01-23', status: 'open' },
    { id: 'pl-inv-003', invoice_number: 'FA2027-1003', customer_name: 'SARL BATIPLUS', customer_reference: null, total: 48000, currency: 'EUR', issuance_date: '2027-01-10', due_date: '2027-01-25', status: 'paid' },           // fermée → hors périmètre
    { id: 'pl-inv-004', invoice_number: 'FA2027-1004', customer_name: 'Atelier Novatek', customer_reference: null, total: 96000, currency: 'CHF', issuance_date: '2027-01-11', due_date: '2027-01-26', status: 'open' },   // devise non supportée → écartée
    { id: 'pl-inv-005', invoice_number: '', customer_name: 'Distribution Sud', customer_reference: null, total: 120000, currency: 'EUR', issuance_date: '2027-01-12', due_date: '2027-01-27', status: 'open' },          // forme invalide → écartée
  ],
  transactions: [
    { id: 'pl-pay-001', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2027-1001 REF CDE-8842', amount: 240000, currency: 'EUR', date: '2027-01-18' }, // exact, avec référence client
    { id: 'pl-pay-002', label: 'VIR RECU MEUBLES DELMAS FACT FA2027-1002', amount: 100000, currency: 'EUR', date: '2027-01-21' },                    // partiel
    { id: 'pl-pay-003', label: 'REJET PRLV SARL BATIPLUS', amount: -18400, currency: 'EUR', date: '2027-01-22' },                                      // rejet
    { id: 'pl-pay-004', label: 'INCOMING WIRE USD REF FA2027-1001', amount: 240000, currency: 'USD', date: '2027-01-19' },                             // devise USD (supportée côté domaine) → mismatch géré par le moteur
    { id: 'pl-pay-005', label: 'VIR SEPA', amount: 64000, currency: 'EUR', date: '2027-01-24' },                                                       // libellé nu
    { id: 'pl-pay-006', label: 'VIR MYSTÈRE', amount: 0, currency: 'EUR', date: '2027-01-25' },                                                        // montant nul → écarté à la traduction
  ],
};

test('connecteur : traduction — factures ouvertes gardées, fermées et devises exotiques écartées avec avertissement', () => {
  const t = translatePennylane(world);
  assert.equal(t.domainInvoices.length, 2);
  assert.deepEqual(t.domainInvoices.map((i) => i.number).sort(), ['FA2027-1001', 'FA2027-1002']);
  assert.equal(t.domainInvoices[0]!.customerReference, 'CDE-8842');
  assert.equal(t.report.invoices.kept, 2);
  assert.equal(t.report.invoices.skippedClosed, 1);
  assert.equal(t.report.invoices.skippedCurrency, 1);
  assert.equal(t.report.invoices.skippedShape, 1);
  assert.ok(t.report.warnings.some((w: string) => w.includes('CHF')));
});

test('connecteur : traduction — transactions valides gardées, nulles écartées, jamais de conversion implicite', () => {
  const t = translatePennylane(world);
  assert.equal(t.domainPayments.length, 5);
  assert.ok(t.domainPayments.some((p) => p.id === 'pl-pay-004' && p.currency === 'USD')); // la devise USD passe au domaine : c'est le moteur qui flag
  assert.ok(!t.domainPayments.some((p) => p.id === 'pl-pay-006'));
  assert.equal(t.report.payments.kept, 5);
  assert.equal(t.report.payments.skippedShape, 1);
  assert.ok(t.report.warnings.some((w: string) => w.includes('montant invalide')));
});

test('connecteur : bout en bout — traduction + moteur v0.2 sur les fixtures Pennylane', () => {
  const t = translatePennylane(world);
  const engine = createV02(config);
  const batch = t.domainPayments;
  const ctx = { customers: t.customers, config, batchPayments: batch };

  const r1 = engine.process(t.domainPayments[0]!, t.domainInvoices, ctx);
  assert.equal(r1.decision, 'proposal');
  assert.equal(r1.classification, 'matched_exact');
  assert.equal(r1.proposal?.invoiceId, 'pl-inv-001');
  assert.equal(r1.proposal?.confidence, 0.99); // référence ET client ET référence de commande lus

  const r2 = engine.process(t.domainPayments[1]!, t.domainInvoices, ctx);
  assert.equal(r2.classification, 'matched_partial');
  assert.equal(r2.proposal?.residualCents, 56000);

  const r3 = engine.process(t.domainPayments[2]!, t.domainInvoices, ctx);
  assert.equal(r3.classification, 'rejected_or_reversal');
  assert.equal(r3.decision, 'flag');

  const r4 = engine.process(t.domainPayments[3]!, t.domainInvoices, ctx);
  assert.equal(r4.classification, 'currency_mismatch');
  assert.equal(r4.decision, 'flag');

  const r5 = engine.process(t.domainPayments[4]!, t.domainInvoices, ctx);
  assert.equal(r5.decision, 'abstain');
  assert.equal(r5.classification, 'unmatched_no_candidate');
});

test('connecteur : invariants traduits — requiresHuman et 0 LLM partout', () => {
  const t = translatePennylane(world);
  const engine = createV02(config);
  const ctx = { customers: t.customers, config, batchPayments: t.domainPayments };
  for (const p of t.domainPayments) {
    const r = engine.process(p, t.domainInvoices, ctx);
    assert.equal(r.requiresHuman, true, p.id);
    assert.equal(r.llmCalls, 0, p.id);
  }
});
