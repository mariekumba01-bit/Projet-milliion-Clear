// Invariants du jeu de données — le harnais n'a de valeur que si la vérité
// terrain est cohérente ; ces tests verrouillent la cohérence ET les effectifs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { getDataset } from '../src/dataset.ts';
import type { Classification } from '../src/types.ts';

const ds = getDataset();

test('effectifs annoncés : 114 paiements — C1 40, C2 56, C3 18, dont 17 verrouillés', () => {
  assert.equal(ds.cases.length, 114);
  assert.equal(ds.meta.total, 114);
  assert.deepEqual(ds.meta.byCohort, { C1: 40, C2: 56, C3: 18 });
  assert.equal(ds.meta.locked, 17);
  assert.equal(ds.cases.filter((c) => c.cohort === 'C3' && c.locked === false).length, 1);
});

test('identifiants de paiements uniques', () => {
  const ids = ds.cases.map((c) => c.payment.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('aucun numéro de facture porté par plus de 2 factures (max = doublon intentionnel)', () => {
  const owners = new Map<string, number>();
  for (const i of ds.invoices) owners.set(i.number, (owners.get(i.number) ?? 0) + 1);
  for (const [num, n] of owners) assert.ok(n <= 2, `${num} porté par ${n} factures`);
});

test('toute proposition attendue vise une facture existante et ouverte', () => {
  for (const c of ds.cases) {
    const e = c.expected;
    if (e.decision === 'proposal') {
      const targetId = e.invoiceId; // hoisté : le rétrécissement ne traverse pas la frontière du callback
      const inv = ds.invoices.find((i) => i.id === targetId);
      assert.ok(inv, `${c.id} : facture ${targetId} introuvable`);
      assert.ok(inv!.open, `${c.id} : proposition visée sur facture fermée`);
    }
  }
});

test('C1 = contrat du terrain natif : 40 propositions matched_exact, résiduel nul', () => {
  for (const c of ds.cases.filter((x) => x.cohort === 'C1')) {
    assert.equal(c.expected.decision, 'proposal', `${c.id} : C1 doit être résolu`);
    assert.equal(c.expected.classification, 'matched_exact');
    assert.equal((c.expected as { residualCents: number }).residualCents, 0);
  }
});

test('dates des paiements dans la fenêtre annoncée 15/09/2026 → 28/11/2026', () => {
  for (const c of ds.cases) {
    assert.ok(c.payment.date >= '2026-09-15' && c.payment.date <= '2026-11-28', `${c.id} : ${c.payment.date} hors fenêtre`);
  }
});

test('le témoin déverrouillé de C3 est la déduction sans indice lisible (proposition partielle attendue)', () => {
  const unlocked = ds.cases.filter((c) => c.cohort === 'C3' && !c.locked);
  assert.equal(unlocked.length, 1);
  const t = unlocked[0]!;
  assert.ok(t.phase2!.includes('déduction sans indice'));
  assert.equal(t.expected.decision, 'proposal');
  assert.equal(t.expected.classification, 'matched_partial');
  assert.equal((t.expected as { residualCents: number }).residualCents, 9600);
});

test('le couple « doublon de paiements » partage bien le même client et se référence lui-même', () => {
  const pair = ds.cases.filter((c) => c.phase2 === 'détection de doublons (paiements)');
  assert.equal(pair.length, 2);
  const a = pair[0]!;
  const b = pair[1]!;
  assert.ok(a.sharedCustomerWith?.includes(b.id), 'a doit référencer b');
  assert.ok(b.sharedCustomerWith?.includes(a.id), 'b doit référencer a');
  const sameCustomer = a.invoices.every((i) => b.invoices.includes(i));
  assert.ok(sameCustomer, 'les deux paiements partagent les mêmes factures candidates');
  assert.equal(a.payment.amountCents, b.payment.amountCents);
  assert.equal(a.payment.date, b.payment.date);
});

test('couverture des classes de la taxonomie par la vérité terrain', () => {
  const seen = new Set(ds.cases.map((c) => c.expected.classification));
  const wanted: Classification[] = [
    'matched_exact', 'matched_partial', 'amount_mismatch', 'currency_mismatch',
    'rejected_or_reversal', 'ambiguous', 'unmatched_no_candidate', 'multi_reference_grouped',
  ];
  for (const k of wanted) assert.ok(seen.has(k), `classe non couverte : ${k}`);
});

test('les 17 cas verrouillés couvrent les 4 verrous phase 2 annoncés', () => {
  const locked = ds.cases.filter((c) => c.locked);
  assert.equal(locked.length, 17);
  const labels = new Set(locked.map((c) => c.phase2));
  for (const want of ['ventilation groupée', 'ventilation libre', 'déduction justifiée', 'doublons']) {
    assert.ok([...labels].some((l) => l!.includes(want)), `verrou absent : ${want} (trouvé : ${[...labels].join(' | ')})`);
  }
});
