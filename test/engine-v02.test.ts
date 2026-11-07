// ─────────────────────────────────────────────────────────────────────────────
// Tests du moteur v0.2 (couche phase 2) — trois axes :
//   1. les 18 cas C3 sont résolus selon la vérité terrain phase 2 (src/phase2.ts) ;
//   2. non-régression STRICTE sur les 96 cas C1+C2 : décision, classe et
//      proposition identiques au v0.1, notes et candidats jamais retirés ;
//   3. négatifs ad hoc : la phase 2 ne force jamais — sans ventilation exacte,
//      sans indice d'acompte, avec client divergent ou combinaisons multiples,
//      le v0.2 garde le verdict v0.1.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset } from '../src/dataset.ts';
import { createEngine as createV01 } from '../src/engine.ts';
import { createEngine as createV02 } from '../src/engine-v02.ts';
import { getPhase2Cases, phase2CoverageOk } from '../src/phase2.ts';
import type { Case, EngineConfig, EngineContext, EngineResult, Invoice, Payment } from '../src/types.ts';

const ds = getDataset();
const v01 = createV01();
const v02 = createV02();
const config: EngineConfig = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };

const batchOf = (c: Case): Payment[] => {
  const partners = c.sharedCustomerWith ?? [];
  const others = ds.cases.filter((x) => partners.includes(x.id)).map((x) => x.payment);
  return [c.payment, ...others];
};
const ctxFor = (c: Case, withBatch = true): EngineContext => ({
  customers: ds.customers, config, ...(withBatch ? { batchPayments: batchOf(c) } : {}),
});

// ── Jugement phase 2 (ventilation autorisée, contrairement au scorer v0.1) ────
function judgePhase2(c: Case, expected: { decision: string; classification: string; invoiceId?: string; residualCents?: number; noteContains?: string; candidatesInclude?: string[] }, r: EngineResult): string[] {
  const errs: string[] = [];
  if (r.decision !== expected.decision) errs.push(`decision ${r.decision} ≠ ${expected.decision}`);
  if (r.classification !== expected.classification) errs.push(`classe ${r.classification} ≠ ${expected.classification}`);
  if (expected.decision === 'proposal') {
    if (!r.proposal) { errs.push('proposition manquante'); return errs; }
    if (expected.invoiceId && r.proposal.invoiceId !== expected.invoiceId) errs.push(`facture ${r.proposal.invoiceId} ≠ ${expected.invoiceId}`);
    if (expected.residualCents != null && Math.abs(r.proposal.residualCents - expected.residualCents) > 1) errs.push(`résiduel ${r.proposal.residualCents} ≠ ${expected.residualCents}`);
    if (r.proposal.evidence.length < 2) errs.push('preuves < 2');
    if (!r.proposal.explanation.trim()) errs.push('explication vide');
    if (r.proposal.breakdown) {
      if (r.proposal.breakdown.reduce((a, b) => a + b.assignedCents, 0) !== c.payment.amountCents) errs.push('la ventilation n\'affecte pas exactement le montant du paiement');
      const valid = new Set(c.invoices.map((i) => i.id));
      for (const b of r.proposal.breakdown) if (!valid.has(b.invoiceId)) errs.push(`ventilation sur facture hors cas : ${b.invoiceId}`);
    }
  } else {
    if (r.proposal) errs.push('proposition interdite ici');
    if (expected.noteContains && !r.notes.join(' | ').toLowerCase().includes(expected.noteContains.toLowerCase())) errs.push(`note attendue : « ${expected.noteContains} »`);
    if (expected.candidatesInclude && !expected.candidatesInclude.every((id) => r.candidates.some((x) => x.invoiceId === id))) errs.push(`candidats attendus : ${expected.candidatesInclude.join(', ')}`);
  }
  if (r.requiresHuman !== true) errs.push('requiresHuman ≠ true');
  if (r.llmCalls !== 0) errs.push('llmCalls ≠ 0');
  return errs;
}

// ── 1. Résolution de la cohorte C3 ────────────────────────────────────────────
test('phase 2 : couverture — 18 spécifications, aucune missing, aucune fantôme', () => {
  const cov = phase2CoverageOk();
  assert.deepEqual(cov.missing, []);
  assert.deepEqual(cov.extra, []);
  assert.equal(cov.ok, true);
  assert.equal(getPhase2Cases().length, 18);
});

test('phase 2 : les 18 cas C3 sont résolus selon la vérité terrain (17 verrous + témoin)', () => {
  const failures: string[] = [];
  for (const entry of getPhase2Cases()) {
    const c = ds.cases.find((x) => x.id === entry.caseId)!;
    const r = v02.process(c.payment, ds.openInvoices, ctxFor(c));
    const errs = judgePhase2(c, entry.expected, r);
    if (errs.length > 0) failures.push(`${entry.caseId} (${entry.label}) : ${errs.join(' ; ')}`);
  }
  assert.deepEqual(failures, [], `échecs de résolution phase 2 :\n  - ${failures.join('\n  - ')}`);
});

test('phase 2 : ventilations au centime — escompte groupe (case-102) et prorata 60 % (case-104)', () => {
  const c102 = ds.cases.find((x) => x.id === 'case-102')!;
  const r102 = v02.process(c102.payment, ds.openInvoices, ctxFor(c102));
  assert.ok(r102.proposal?.breakdown);
  assert.deepEqual(r102.proposal.breakdown.map((b) => b.residualCents), c102.invoices.map((i) => Math.round(i.amountCents * 0.02)));
  assert.deepEqual(r102.proposal.breakdown.map((b) => b.assignedCents), c102.invoices.map((i) => i.amountCents - Math.round(i.amountCents * 0.02)));

  const c104 = ds.cases.find((x) => x.id === 'case-104')!;
  const r104 = v02.process(c104.payment, ds.openInvoices, ctxFor(c104));
  assert.ok(r104.proposal?.breakdown);
  assert.deepEqual(r104.proposal.breakdown.map((b) => b.assignedCents), [288000, 144000]);
  assert.deepEqual(r104.proposal.breakdown.map((b) => b.residualCents), [192000, 96000]);
  assert.equal(r104.proposal.breakdown.reduce((a, b) => a + b.assignedCents, 0), 432000);
});

test('phase 2 : le témoin case-110 passe de partiel (v0.1) à déduction reconnue (v0.2), résiduel nul', () => {
  const c = ds.cases.find((x) => x.id === 'case-110')!;
  const r1 = v01.process(c.payment, ds.openInvoices, ctxFor(c));
  const r2 = v02.process(c.payment, ds.openInvoices, ctxFor(c));
  assert.equal(r1.classification, 'matched_partial');   // v0.1 : partiel, résiduel 9 600
  assert.equal(r1.proposal?.residualCents, 9600);
  assert.equal(r2.classification, 'matched_exact');     // v0.2 : déduction 2 % reconnue
  assert.equal(r2.proposal?.residualCents, 0);
  assert.ok(r2.notes.some((n) => n.includes('déduction de 2 % reconnue')));
});

// ── 2. Non-régression stricte sur C1 + C2 (96 cas) ────────────────────────────
test('non-régression : sur les 96 cas C1+C2, v0.2 = v0.1 sur décision, classe et proposition', () => {
  const failures: string[] = [];
  const targets = ds.cases.filter((c) => c.cohort === 'C1' || c.cohort === 'C2');
  assert.equal(targets.length, 96);
  for (const c of targets) {
    const ctx = ctxFor(c);
    const a = v01.process(c.payment, ds.openInvoices, ctx);
    const b = v02.process(c.payment, ds.openInvoices, ctx);
    if (a.decision !== b.decision || a.classification !== b.classification) failures.push(`${c.id} : ${a.decision}/${a.classification} → ${b.decision}/${b.classification}`);
    if (JSON.stringify(a.proposal) !== JSON.stringify(b.proposal)) failures.push(`${c.id} : proposition modifiée`);
    for (const n of a.notes) if (!b.notes.includes(n)) failures.push(`${c.id} : note v0.1 retirée « ${n} »`);
    for (const cand of a.candidates) if (!b.candidates.some((x) => x.invoiceId === cand.invoiceId)) failures.push(`${c.id} : candidat v0.1 retiré ${cand.invoiceId}`);
  }
  assert.deepEqual(failures, [], `régressions C1+C2 :\n  - ${failures.join('\n  - ')}`);
});

test('invariants v0.2 sur tout le dataset : requiresHuman, 0 LLM, proposal ⟺ decision proposal', () => {
  for (const c of ds.cases) {
    const r = v02.process(c.payment, ds.openInvoices, ctxFor(c));
    assert.equal(r.requiresHuman, true, c.id);
    assert.equal(r.llmCalls, 0, c.id);
    if (r.decision === 'proposal') {
      assert.ok(r.proposal, c.id);
      assert.ok(r.proposal!.evidence.length >= 2, c.id);
      assert.ok(r.proposal!.explanation.trim().length > 0, c.id);
    } else {
      assert.equal(r.proposal, null, c.id);
    }
  }
});

// ── 3. Négatifs ad hoc : la phase 2 ne force jamais ───────────────────────────
const inv = (id: string, number: string, customer: string, amountCents: number, due = '2026-10-31'): Invoice => ({
  id, number, customer, customerReference: null, amountCents, currency: 'EUR',
  issueDate: '2026-10-01', dueDate: due, open: true,
});
const pay = (id: string, label: string, amountCents: number, date = '2026-10-20'): Payment => ({
  id, label, amountCents, currency: 'EUR', date,
});
const cfg = (customers: string[], batch?: Payment[]): EngineContext => ({ customers, config, ...(batch ? { batchPayments: batch } : {}) });

test('négatif : virement groupé sans ventilation exacte → reste un flag, aucun montant affecté', () => {
  const i1 = inv('a1', 'FA2026-0501', 'SARL TEST', 240000);
  const i2 = inv('a2', 'FA2026-0502', 'SARL TEST', 156000);
  const p = pay('p1', 'VIR SEPA RECU DE SARL TEST REGLEMENT FACT FA2026-0501 + FA2026-0502', 350000); // somme 396 000 − 46 000 : ni 2 %, ni prorata
  const r = v02.process(p, [i1, i2], cfg(['SARL TEST']));
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'multi_reference_grouped');
  assert.equal(r.proposal, null);
  assert.ok(r.notes.some((n) => n.includes('aucune ventilation exacte')));
});

test('négatif : écart de 2 % mais client du libellé divergent → reste ambigu, jamais de déduction', () => {
  const i1 = inv('b1', 'FA2026-0503', 'AUTRE CLIENT', 2400000);
  const p = pay('p2', 'VIR SEPA RECU DE SARL TEST FACT FA2026-0503 ESCOMPTE 2 PCT', 2352000);
  const r = v02.process(p, [i1], cfg(['SARL TEST', 'AUTRE CLIENT']));
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.equal(r.proposal, null);
  assert.ok(r.notes.some((n) => n.includes('erreur de saisie probable')));
});

test('négatif : paiement inférieur à la facture unique mais sans mot ACOMPTE → reste abstention', () => {
  const i1 = inv('c1', 'FA2026-0504', 'SARL TEST', 360000);
  const p = pay('p3', 'VIR RECU SARL TEST', 144000);
  const r = v02.process(p, [i1], cfg(['SARL TEST']));
  assert.equal(r.decision, 'abstain');
  assert.equal(r.classification, 'unmatched_no_candidate');
  assert.equal(r.proposal, null);
});

test('négatif : acompte mais client à plusieurs factures ouvertes → reste abstention (aucun choix arbitraire)', () => {
  const i1 = inv('d1', 'FA2026-0505', 'SARL TEST', 360000);
  const i2 = inv('d2', 'FA2026-0506', 'SARL TEST', 120000);
  const p = pay('p4', 'VIR RECU SARL TEST ACOMPTE', 144000);
  const r = v02.process(p, [i1, i2], cfg(['SARL TEST']));
  assert.equal(r.decision, 'abstain');
  assert.equal(r.classification, 'unmatched_no_candidate');
  assert.equal(r.proposal, null);
});

test('négatif : deux combinaisons somment au montant → ambigu, candidats listés, jamais de ventilation', () => {
  // 100 000 + 60 000 = 160 000 et 90 000 + 70 000 = 160 000
  const invs = [
    inv('e1', 'FA2026-0511', 'SARL TEST', 100000),
    inv('e2', 'FA2026-0512', 'SARL TEST', 60000),
    inv('e3', 'FA2026-0513', 'SARL TEST', 90000),
    inv('e4', 'FA2026-0514', 'SARL TEST', 70000),
  ];
  const p = pay('p5', 'VIR RECU SARL TEST', 160000);
  const r = v02.process(p, invs, cfg(['SARL TEST']));
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.equal(r.proposal, null);
  assert.ok(r.notes.some((n) => n.includes('combinaisons de factures ouvertes somment au montant')));
  assert.deepEqual([...r.candidates.map((x) => x.invoiceId)].sort(), ['e1', 'e2', 'e3', 'e4']);
});

test('négatif : doublon de paiement — sans lot d\'import, pas d\'alerte phase 2 (dégradation gracieuse)', () => {
  const i1 = inv('f1', 'FA2026-0521', 'SARL TEST', 120000);
  const i2 = inv('f2', 'FA2026-0522', 'SARL TEST', 120000);
  const p = pay('p6', 'VIR RECU SARL TEST', 120000);
  const r = v02.process(p, [i1, i2], cfg(['SARL TEST'])); // pas de batchPayments
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.ok(!r.notes.some((n) => n.includes('doublon de paiement probable')));
});

test('positif ad hoc : doublon de paiement — avec le lot, l\'alerte phase 2 apparaît', () => {
  const i1 = inv('g1', 'FA2026-0531', 'SARL TEST', 120000);
  const i2 = inv('g2', 'FA2026-0532', 'SARL TEST', 120000);
  const p = pay('p7', 'VIR RECU SARL TEST', 120000);
  const twin = pay('p8', 'VIR RECU SARL TEST', 120000, '2026-10-21');
  const r = v02.process(p, [i1, i2], cfg(['SARL TEST'], [p, twin]));
  assert.equal(r.decision, 'flag');
  assert.equal(r.classification, 'ambiguous');
  assert.ok(r.notes.some((n) => n.includes('doublon de paiement probable') && n.includes('p8')));
});
