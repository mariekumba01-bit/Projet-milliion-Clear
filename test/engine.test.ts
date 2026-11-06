// Tests unitaires du moteur de référence — fixtures construites à la main,
// indépendamment du jeu de données (le dataset a ses propres tests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../src/engine.ts';
import type { EngineContext, EngineResult, Invoice, Payment } from '../src/types.ts';

const config = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };
const customers = ['SARL BATIPLUS', 'Meubles Delmas', 'Atelier Novatek'];
const ctx: EngineContext = { customers, config };
const engine = createEngine();

const mkInv = (o: Partial<Invoice> & Pick<Invoice, 'id' | 'number' | 'customer' | 'amountCents'>): Invoice => ({
  currency: 'EUR', issueDate: '2026-10-01', dueDate: '2026-10-31', open: true, customerReference: null, ...o,
});
const mkPay = (o: Partial<Payment> & Pick<Payment, 'id' | 'label' | 'amountCents'>): Payment => ({
  currency: 'EUR', date: '2026-10-20', ...o,
});
const open = (invs: Invoice[]): Invoice[] => [...invs];

test('référence + client + montant exact → proposition matched_exact, confiance 0,99', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0102', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0102', amountCents: 240000 }), open([inv]), ctx);
  assert.equal(r.decision, 'proposal');
  assert.equal(r.classification, 'matched_exact');
  assert.equal(r.proposal!.invoiceId, 'i1');
  assert.equal(r.proposal!.residualCents, 0);
  assert.equal(r.proposal!.confidence, 0.99);
  assert.ok(r.proposal!.evidence.length >= 2);
  assert.ok(r.proposal!.explanation.length > 0);
  assert.equal(r.requiresHuman, true);
  assert.equal(r.llmCalls, 0);
});

test('référence sans préfixe FA (« N° 2026-0102 ») → toujours rapproché', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0102', customer: 'Meubles Delmas', amountCents: 156000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR RECU DE MEUBLES DELMAS FACT N° 2026-0102', amountCents: 156000 }), open([inv]), ctx);
  assert.equal(r.decision, 'proposal');
  assert.equal(r.proposal!.invoiceId, 'i1');
});

test('montants avec séparateurs et zéros de tête dans le libellé → rapproché', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0102', customer: 'Atelier Novatek', amountCents: 96500 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR RECU ATELIER NOVATEK FACT FA 2026 102', amountCents: 96500 }), open([inv]), ctx);
  assert.equal(r.decision, 'proposal');
  assert.equal(r.proposal!.invoiceId, 'i1');
});

test('paiement partiel avec référence → matched_partial, résiduel calculé', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0103', customer: 'SARL BATIPLUS', amountCents: 480000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0103', amountCents: 240000 }), open([inv]), ctx);
  assert.equal(r.decision, 'proposal');
  assert.equal(r.classification, 'matched_partial');
  assert.equal(r.proposal!.residualCents, 240000);
  assert.equal(r.proposal!.assignedAmountCents, 240000);
});

test('transaction négative → rejet signalé, jamais proposée', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0104', customer: 'SARL BATIPLUS', amountCents: 48000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'PRLV SEPA RETOUR SARL BATIPLUS FACT FA2026-0104', amountCents: -48000 }), open([inv]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'rejected_or_reversal');
  assert.equal(r.proposal, null);
});

test('écart ≤ 8,00 € sous la facture → flag frais/déduction, pas de proposition', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0105', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0105', amountCents: 239510 }), open([inv]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'amount_mismatch');
  assert.equal(r.proposal, null);
});

test('paiement au-dessus de la facture → flag, pas de proposition', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0106', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0106', amountCents: 390000 }), open([inv]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'amount_mismatch');
});

test('devise différente (USD entrant) → rapprochement bloqué', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0107', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'INCOMING WIRE USD REF FA2026-0107', amountCents: 240000, currency: 'USD' }), open([inv]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'currency_mismatch');
});

test('même client, deux factures de même montant, sans référence → ambigu, candidats classés, jamais proposé', () => {
  const i1 = mkInv({ id: 'i1', number: 'FA2026-0108', customer: 'Meubles Delmas', amountCents: 120000, dueDate: '2026-11-10' });
  const i2 = mkInv({ id: 'i2', number: 'FA2026-0109', customer: 'Meubles Delmas', amountCents: 120000, dueDate: '2026-11-25' });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR RECU MEUBLES DELMAS', amountCents: 120000, date: '2026-11-12' }), open([i1, i2]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.equal(r.proposal, null);
  assert.deepEqual(r.candidates.map((c) => c.invoiceId).sort(), ['i1', 'i2']);
});

test('référence lue mais client du libellé différent → ambigu (erreur de saisie probable)', () => {
  const invPayer = mkInv({ id: 'ip', number: 'FA2026-0110', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const invOther = mkInv({ id: 'io', number: 'FA2026-0111', customer: 'Atelier Novatek', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0111', amountCents: 240000 }), open([invPayer, invOther]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.ok(r.candidates.some((c) => c.invoiceId === 'io'));
});

test('deux références distinctes dans un même libellé → virement groupé, aucun montant affecté', () => {
  const i1 = mkInv({ id: 'i1', number: 'FA2026-0112', customer: 'SARL BATIPLUS', amountCents: 120000 });
  const i2 = mkInv({ id: 'i2', number: 'FA2026-0113', customer: 'SARL BATIPLUS', amountCents: 90000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA RECU DE SARL BATIPLUS REGLEMENT FACT FA2026-0112 + FA2026-0113', amountCents: 210000 }), open([i1, i2]), ctx);
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'multi_reference_grouped');
  assert.equal(r.proposal, null);
  assert.deepEqual(r.candidates.map((c) => c.invoiceId).sort(), ['i1', 'i2']);
});

test('libellé nu sans référence ni client → abstinence, pas de rapprochement approximatif', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0114', customer: 'SARL BATIPLUS', amountCents: 64000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR SEPA', amountCents: 64000 }), open([inv]), ctx);
  assert.equal(r.decision, 'abstain');
  assert.equal(r.classification, 'unmatched_no_candidate');
});

test('fausse référence (transposition de chiffres) → abstinence, pas de proposition approximative', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0142', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR RECU FA2026-9142 DG', amountCents: 240000 }), open([inv]), ctx);
  assert.equal(r.decision, 'abstain');
  assert.equal(r.classification, 'unmatched_no_candidate');
});

test('client + montant exact unique, sans référence → proposition à confiance limitée (0,80)', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0115', customer: 'Atelier Novatek', amountCents: 335000 });
  const r = engine.process(mkPay({ id: 'p1', label: 'VIR RECU ATELIER NOVATEK', amountCents: 335000 }), open([inv]), ctx);
  assert.equal(r.decision, 'proposal');
  assert.equal(r.classification, 'matched_exact');
  assert.equal(r.proposal!.confidence, 0.8);
  assert.ok(r.notes.some((n) => n.includes('vérifier')));
});

test('invariants structurels sur tout résultat : requiresHuman, 0 appel LLM, explication non vide si proposition', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0116', customer: 'SARL BATIPLUS', amountCents: 240000 });
  const payments: Payment[] = [
    mkPay({ id: 'a', label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0116', amountCents: 240000 }),
    mkPay({ id: 'b', label: 'PRLV RETOUR', amountCents: -1200 }),
    mkPay({ id: 'c', label: 'VIR SEPA', amountCents: 5000 }),
  ];
  for (const p of payments) {
    const r: EngineResult = engine.process(p, open([inv]), ctx);
    assert.equal(r.requiresHuman, true, `${p.id} : requiresHuman doit être true`);
    assert.equal(r.llmCalls, 0, `${p.id} : moteur déterministe`);
    if (r.decision === 'proposal') assert.ok(r.proposal!.explanation.trim().length > 0);
  }
});

test('déterminisme : même entrée → même sortie (double exécution)', () => {
  const inv = mkInv({ id: 'i1', number: 'FA2026-0117', customer: 'Meubles Delmas', amountCents: 156000 });
  const p = mkPay({ id: 'p1', label: 'VIR RECU MEUBLES DELMAS FACT FA2026-0117', amountCents: 100000 });
  const r1 = engine.process(p, open([inv]), ctx);
  const r2 = engine.process(p, open([inv]), ctx);
  assert.deepEqual(r1, r2);
});
