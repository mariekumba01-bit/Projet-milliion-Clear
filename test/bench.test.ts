// Tests du harnais de mesure. Deux exigences :
//  1. le moteur de référence passe les 4 portes (sinon le banc ne mesure rien) ;
//  2. un moteur NÉGLIGENT échoue — sinon le harnais est incapable de détecter
//     une violation et ses PASS ne prouvent rien (témoin négatif obligatoire).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { runBenchmark } from '../src/bench.ts';
import { loadEngine } from '../src/adapter.ts';
import type { Engine } from '../src/types.ts';

test('moteur de référence : les 4 portes passent, précision et résolution de 100 %', () => {
  const { metrics } = runBenchmark();
  assert.equal(metrics.totals.cases, 114);
  assert.equal(metrics.gates.audit, true, `violations audit : ${metrics.totals.hard}`);
  assert.equal(metrics.gates.c1Exact, true);
  assert.equal(metrics.gates.c3Discipline, true);
  assert.equal(metrics.gates.llmFree, true);
  assert.equal(metrics.totals.hard, 0);
  assert.equal(metrics.totals.soft, 0, `manques mineurs inattendus : ${metrics.totals.soft}`);
  assert.equal(metrics.precision, 1);
  assert.equal(metrics.resolution.expected, 52);
  assert.equal(metrics.resolution.rate, 1);
  assert.equal(metrics.proposals.made, 52);
  assert.deepEqual(metrics.byCohort, {
    C1: { n: 40, ok: 40, hard: 0, soft: 0 },
    C2: { n: 56, ok: 56, hard: 0, soft: 0 },
    C3: { n: 18, ok: 18, hard: 0, soft: 0 },
  });
});

test('coût : très en dessous des plafonds kill (0,50 € et 0,10 € par opération)', () => {
  const { metrics } = runBenchmark();
  assert.ok(metrics.cost.eurPerOp < 0.1, `coût ${metrics.cost.eurPerOp} €/op`);
  assert.equal(metrics.cost.verdictNow, 'PASS');
  assert.equal(metrics.cost.verdictTrajectory, 'PASS');
  assert.equal(metrics.perf.llmCalls, 0);
});

test('bandes de confiance : toutes les propositions tombées sont nulles, aucune bande fausse', () => {
  const { metrics } = runBenchmark();
  for (const b of metrics.confidenceBands) {
    assert.equal(b.wrong, 0, `bande ${b.band} : ${b.wrong} propositions fausses`);
  }
  assert.ok(metrics.confidenceBands.some((b) => b.band === '≥ 0,95'));
  assert.ok(metrics.confidenceBands.some((b) => b.band === '< 0,85'), 'la proposition sans référence (0,80) doit apparaître');
});

test('rapport rendu : portes visibles, sections attendues, aucune proposition illégale', () => {
  const { reportMd } = runBenchmark();
  assert.ok(reportMd.includes('Portes de validation'));
  assert.ok(reportMd.includes('✅ PASS'));
  assert.ok(reportMd.includes('Matrice de confusion'));
  assert.ok(reportMd.includes('Backlog phase 2'));
  assert.ok(!reportMd.includes('⚠'), 'aucune section d\'alerte ne doit apparaître');
  assert.ok(!reportMd.includes('undefined'));
  assert.ok(!reportMd.includes('NaN'));
});

// ── Témoin négatif : le moteur négligent ──────────────────────────────────────
// Propose la première facture ouverte pour CHAQUE paiement, avec une confiance
// de façade. Si le harnais est honnête, il doit l'éliminer sur toutes les portes.
const sloppy: Engine = {
  process(payment, openInvoices, _context) {
    const target = openInvoices[0]!;
    return {
      paymentId: payment.id,
      requiresHuman: true,
      decision: 'proposal',
      classification: 'matched_exact',
      proposal: {
        invoiceId: target.id,
        assignedAmountCents: payment.amountCents,
        residualCents: 0,
        confidence: 0.99,
        evidence: [{ kind: 'référence', detail: 'aucune' }, { kind: 'montant', detail: 'aucun' }],
        explanation: 'toujours la première facture ouverte',
      },
      candidates: [],
      notes: [],
      llmCalls: 0,
    };
  },
};

test('témoin négatif : le moteur négligent est éliminé par les portes', () => {
  const { metrics } = runBenchmark({ engine: sloppy });
  assert.equal(metrics.gates.audit, false, 'le harnais doit détecter les appariements faux');
  assert.equal(metrics.gates.c1Exact, false);
  assert.equal(metrics.gates.c3Discipline, false);
  assert.ok(metrics.lockedProposals.length >= 17, 'des propositions illégales doivent être listées sur les cas verrouillés');
  assert.equal(metrics.totals.hard, 113); // seul case-001 est « résolu » par accident (inv-001 est bien sa cible)
  assert.equal(metrics.proposals.correct, 1);
  assert.ok(metrics.resolution.rate < 0.05, `résolution ${metrics.resolution.rate}`);
  assert.ok(metrics.precision < 0.05);
});

test('témoin négatif : le rapport affiche bien l\'échec (pas de PASS mensonger)', () => {
  const { reportMd } = runBenchmark({ engine: sloppy });
  assert.ok(reportMd.includes('❌ FAIL'));
  assert.ok(reportMd.includes('⚠'));
});

test('contrat d\'adaptateur : le moteur se charge par chemin de configuration', async () => {
  const enginePath = fileURLToPath(new URL('../src/engine.ts', import.meta.url));
  const engine = await loadEngine(enginePath, { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 });
  assert.equal(typeof engine.process, 'function');
  // le moteur chargé par l'adaptateur se comporte comme l'original
  const r = engine.process(
    { id: 'p', label: 'VIR RECU FACT FA2026-0102', amountCents: 100, currency: 'EUR', date: '2026-10-01' },
    [{ id: 'i', number: 'FA2026-0102', customer: 'X', customerReference: null, amountCents: 240000, currency: 'EUR', issueDate: '2026-09-01', dueDate: '2026-10-01', open: true }],
    { customers: ['X'], config: { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 } },
  );
  assert.equal(r.decision, 'proposal');
});
