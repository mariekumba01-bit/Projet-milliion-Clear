// ─────────────────────────────────────────────────────────────────────────────
// Harnais de mesure ClearMatch v0.1 — runner, scorer, rapport.
//
// Philosophie de scoring « audit-ready » :
//   • un appariement FAUX (facture au mauvais client, classe erronée, proposition
//     là où l'abstinence était requise) est une violation HARD → AUDIT_GATE échoue ;
//   • une note ou un candidat manquant est une violation SOFT (dégrade la confiance,
//     ne fabrique pas un faux rapprochement) ;
//   • une absence de proposition là où une proposition était attendue est un manque
//     de résolution (SAFE : n'induit personne en erreur).
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join, dirname, resolve } from 'node:path';
import { loadEngine } from './adapter.ts';
import { getDataset, type Dataset } from './dataset.ts';
import { createEngine } from './engine.ts';
import { CLASSES, type Case, type Classification, type Engine, type EngineConfig, type EngineResult } from './types.ts';

export interface BenchConfig extends EngineConfig {
  engine: string;
  engineName: string;
  computeEurPerHour: number;
  killCeilings: { nowEurPerOp: number; trajectoryEurPerOp: number };
  reportDir: string;
}

export type OutcomeKind =
  | 'ok'
  | 'no_proposal'            // attendu : proposition — le moteur s'est tu (échec de résolution, direction sûre)
  | 'forced'                 // proposition là où flag/abstention attendu — violation audit
  | 'wrong_invoice'          // proposition sur la mauvaise facture — violation audit
  | 'wrong_class'            // classe erronée — violation audit
  | 'bad_shape'              // résiduel/affectation/preuves incorrects — violation audit
  | 'wrong_decision'         // flag↔abstention (même classe) — soft
  | 'missing_note'           // note attendue absente — soft
  | 'missing_candidate';     // candidat attendu absent — soft

export interface CaseOutcome {
  caseId: string; cohort: string; phase2?: string; locked: boolean;
  expectedClass: Classification; expectedDecision: string;
  gotClass: Classification; gotDecision: string;
  kind: OutcomeKind; latencyMs: number; detail: string;
  confidence: number | null;
}

const HARD: OutcomeKind[] = ['forced', 'wrong_invoice', 'wrong_class', 'bad_shape'];
const isHard = (k: OutcomeKind) => HARD.includes(k);

const normLow = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ── Comparaison d'un résultat à sa vérité terrain ─────────────────────────────
function judge(c: Case, r: EngineResult): { kind: OutcomeKind; detail: string } {
  const e = c.expected;
  if (e.decision === 'proposal') {
    if (r.decision !== 'proposal') {
      return { kind: 'no_proposal', detail: `proposition attendue sur ${e.invoiceId}, moteur : ${r.decision}/${r.classification}` };
    }
    if (r.classification !== e.classification) {
      return { kind: 'wrong_class', detail: `attendu ${e.classification}, reçu ${r.classification}` };
    }
    if (r.proposal!.invoiceId !== e.invoiceId) {
      return { kind: 'wrong_invoice', detail: `attendu ${e.invoiceId}, reçu ${r.proposal!.invoiceId}` };
    }
    const p = r.proposal!;
    if (Math.abs(p.residualCents - e.residualCents) > 1) {
      return { kind: 'bad_shape', detail: `résiduel attendu ${e.residualCents}, reçu ${p.residualCents}` };
    }
    if (p.assignedAmountCents !== c.payment.amountCents) {
      return { kind: 'bad_shape', detail: 'affectation ≠ montant du paiement (ventilation interdite en v0.1)' };
    }
    if (p.evidence.length < 2 || !p.explanation.trim()) {
      return { kind: 'bad_shape', detail: 'preuves < 2 ou explication vide' };
    }
    return { kind: 'ok', detail: '' };
  }
  // attendu : flag ou abstention
  if (r.decision === 'proposal') {
    return { kind: 'forced', detail: `proposition interdite ici (attendu ${e.decision}/${e.classification})` };
  }
  if (r.classification !== e.classification) {
    return { kind: 'wrong_class', detail: `attendu ${e.classification}, reçu ${r.classification}` };
  }
  if (r.decision !== e.decision) {
    return { kind: 'wrong_decision', detail: `attendu ${e.decision}, reçu ${r.decision} (même classe)` };
  }
  if (e.noteContains && !normLow(r.notes.join(' | ')).includes(normLow(e.noteContains))) {
    return { kind: 'missing_note', detail: `note attendue : « ${e.noteContains} »` };
  }
  if (e.candidatesInclude && !e.candidatesInclude.every((id) => r.candidates.some((cand) => cand.invoiceId === id))) {
    return { kind: 'missing_candidate', detail: `candidats attendus : ${e.candidatesInclude.join(', ')}` };
  }
  return { kind: 'ok', detail: '' };
}

// ── Exécution ─────────────────────────────────────────────────────────────────
export interface RunResult {
  outcomes: CaseOutcome[];
  metrics: Metrics;
  reportJson: string;
  reportMd: string;
}

export function runBenchmark(opts?: { engine?: Engine; dataset?: Dataset; config?: Partial<BenchConfig> }): RunResult {
  const here = dirname(fileURLToPath(import.meta.url));
  const fileConfig = JSON.parse(readFileSync(join(here, '../benchmark.config.json'), 'utf8')) as BenchConfig;
  const config: BenchConfig = { ...fileConfig, ...opts?.config } as BenchConfig;

  const dataset = opts?.dataset ?? getDataset();
  const engine = opts?.engine ?? createEngine(config);
  const engineName = opts?.config?.engineName ?? config.engineName;

  const outcomes: CaseOutcome[] = [];
  const latencies: number[] = [];
  let llmCalls = 0;

  for (const c of dataset.cases) {
    const t0 = performance.now();
    const r: EngineResult = engine.process(c.payment, dataset.openInvoices, { customers: dataset.customers, config });
    const latencyMs = performance.now() - t0;
    latencies.push(latencyMs);
    llmCalls += r.llmCalls ?? 0;
    if (r.decision === 'proposal' && !r.proposal) throw new Error(`${c.id} : decision=proposal sans objet proposal`);
    const { kind, detail } = judge(c, r);
    outcomes.push({
      caseId: c.id, cohort: c.cohort, phase2: c.phase2, locked: !!c.locked,
      expectedClass: c.expected.classification, expectedDecision: c.expected.decision,
      gotClass: r.classification, gotDecision: r.decision, kind, latencyMs, detail,
      confidence: r.proposal?.confidence ?? null,
    });
  }

  const metrics = computeMetrics(outcomes, latencies, llmCalls, dataset, config, engineName);
  return { outcomes, metrics, reportJson: JSON.stringify({ engineName, metrics, outcomes }, null, 2), reportMd: renderMd(metrics) };
}

// ── Métriques ─────────────────────────────────────────────────────────────────
export interface Metrics {
  engineName: string;
  totals: { cases: number; ok: number; hard: number; soft: number };
  gates: { audit: boolean; c1Exact: boolean; c3Discipline: boolean; llmFree: boolean };
  precision: number;
  proposals: { made: number; correct: number; wrong: number; evidenceComplete: number };
  resolution: { expected: number; correct: number; rate: number };
  byCohort: Record<string, { n: number; ok: number; hard: number; soft: number }>;
  confusion: Record<string, Record<string, number>>;
  confidenceBands: Array<{ band: string; correct: number; wrong: number }>;
  lockedProposals: string[];
  phase2Backlog: Array<{ label: string; cases: string[]; lockedCount: number }>;
  perf: { medianMs: number; p95Ms: number; totalMs: number; opsPerSec: number; llmCalls: number };
  cost: { eurPerOp: number; ceilingNow: number; ceilingTrajectory: number; verdictNow: string; verdictTrajectory: string; assumption: string };
}

function computeMetrics(outcomes: CaseOutcome[], latencies: number[], llmCalls: number, dataset: Dataset, config: BenchConfig, engineName: string): Metrics {
  const confusion: Record<string, Record<string, number>> = {};
  for (const row of CLASSES) { confusion[row] = {}; for (const col of CLASSES) confusion[row][col] = 0; }
  const byCohort: Record<string, { n: number; ok: number; hard: number; soft: number }> = {};
  let ok = 0, hard = 0, soft = 0, made = 0, correct = 0, wrong = 0, evComplete = 0;
  let resExpected = 0, resCorrect = 0;
  const lockedProposals: string[] = [];
  const bands = new Map<string, { correct: number; wrong: number }>();

  const bandOf = (c: number | null): string =>
    c === null ? 'sans confiance' : c >= 0.95 ? '≥ 0,95' : c >= 0.85 ? '0,85–0,95' : '< 0,85';

  for (const o of outcomes) {
    confusion[o.expectedClass][o.gotClass] = (confusion[o.expectedClass][o.gotClass] ?? 0) + 1;
    byCohort[o.cohort] ??= { n: 0, ok: 0, hard: 0, soft: 0 };
    byCohort[o.cohort].n += 1;
    if (o.kind === 'ok') { ok += 1; byCohort[o.cohort].ok += 1; }
    else if (isHard(o.kind)) { hard += 1; byCohort[o.cohort].hard += 1; }
    else { soft += 1; byCohort[o.cohort].soft += 1; }

    // dénominateur honnête : toute attente de proposition compte, résolue ou non
    if (o.expectedDecision === 'proposal') {
      resExpected += 1;
      if (o.kind === 'ok') resCorrect += 1;
    }

    if (o.gotDecision === 'proposal') {
      made += 1;
      if (o.kind === 'ok') { correct += 1; evComplete += 1; } else { wrong += 1; }
      if (o.locked) lockedProposals.push(o.caseId);
      const band = bandOf(o.confidence);
      const b = bands.get(band) ?? { correct: 0, wrong: 0 };
      if (o.kind === 'ok') b.correct += 1; else b.wrong += 1;
      bands.set(band, b);
    }
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const medianMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const p95Ms = sorted[Math.ceil(sorted.length * 0.95) - 1] ?? 0;
  const totalMs = latencies.reduce((a, b) => a + b, 0);
  const eurPerOp = (medianMs / 3_600_000) * config.computeEurPerHour;

  const backlog: Array<{ label: string; cases: string[]; lockedCount: number }> = [];
  for (const o of outcomes) {
    if (o.phase2) {
      let entry = backlog.find((b) => b.label === o.phase2);
      if (!entry) { entry = { label: o.phase2, cases: [], lockedCount: 0 }; backlog.push(entry); }
      entry.cases.push(o.caseId);
      if (o.locked) entry.lockedCount += 1;
    }
  }

  const c1 = byCohort.C1 ?? { n: 0, ok: 0, hard: 0, soft: 0 };
  return {
    engineName,
    totals: { cases: outcomes.length, ok, hard, soft },
    gates: {
      audit: hard === 0,
      c1Exact: c1.n > 0 && c1.n === c1.ok,
      c3Discipline: lockedProposals.length === 0,
      llmFree: llmCalls === 0,
    },
    precision: made > 0 ? correct / made : 0,
    proposals: { made, correct, wrong, evidenceComplete: evComplete },
    resolution: { expected: resExpected, correct: resCorrect, rate: resExpected > 0 ? resCorrect / resExpected : 0 },
    byCohort,
    confusion,
    confidenceBands: [...bands.entries()].map(([band, v]) => ({ band, ...v })),
    lockedProposals,
    phase2Backlog: backlog,
    perf: { medianMs, p95Ms, totalMs, opsPerSec: totalMs > 0 ? outcomes.length / (totalMs / 1000) : 0, llmCalls },
    cost: {
      eurPerOp,
      ceilingNow: config.killCeilings.nowEurPerOp,
      ceilingTrajectory: config.killCeilings.trajectoryEurPerOp,
      verdictNow: eurPerOp <= config.killCeilings.nowEurPerOp ? 'PASS' : 'FAIL',
      verdictTrajectory: eurPerOp <= config.killCeilings.trajectoryEurPerOp ? 'PASS' : 'FAIL',
      assumption: `médiane ${medianMs.toFixed(4)} ms/op × ${config.computeEurPerHour} €/h de calcul (vCPU partagé) — moteur déterministe, 0 appel LLM`,
    },
  };
}

// ── Rendu Markdown ────────────────────────────────────────────────────────────
const pct = (x: number) => `${(x * 100).toFixed(1)} %`;

function renderMd(m: Metrics): string {
  const L: string[] = [];
  L.push(`# ClearMatch Benchmark — rapport de mesure`);
  L.push('');
  L.push(`- **Moteur** : ${m.engineName}`);
  L.push(`- **Cas** : ${m.totals.cases} (C1 natif / C2 v0.1 / C3 phase 2 verrouillée)`);
  L.push(`- **Résultat** : ${m.totals.ok} corrects, ${m.totals.hard} violations audit, ${m.totals.soft} manques mineurs`);
  L.push('');
  L.push(`## Portes de validation (gates)`);
  L.push('');
  L.push(`| Porte | Critère | Verdict |`);
  L.push(`| --- | --- | --- |`);
  L.push(`| AUDIT | zéro appariement faux ou forcé | ${m.gates.audit ? '✅ PASS' : '❌ FAIL'} |`);
  L.push(`| C1 — terrain natif | 100 % de rapprochements simples réussis | ${m.gates.c1Exact ? '✅ PASS' : '❌ FAIL'} |`);
  L.push(`| C3 — discipline | zéro proposition sur un cas verrouillé phase 2 | ${m.gates.c3Discipline ? '✅ PASS' : '❌ FAIL'} |`);
  L.push(`| Coût déterministe | 0 appel LLM par opération | ${m.gates.llmFree ? '✅ PASS' : '❌ FAIL'} |`);
  L.push('');
  L.push(`## Résolution et précision`);
  L.push('');
  L.push(`- Précision des propositions : **${pct(m.precision)}** (${m.proposals.correct}/${m.proposals.made})`);
  L.push(`- Taux de résolution (propositions attendues et correctes) : **${pct(m.resolution.rate)}** (${m.resolution.correct}/${m.resolution.expected})`);
  L.push(`- Complétude des preuves (≥ 2 preuves + explication) : ${m.proposals.made > 0 ? pct(m.proposals.evidenceComplete / m.proposals.made) : '—'}`);
  L.push('');
  L.push(`## Par cohorte`);
  L.push('');
  L.push(`| Cohorte | n | corrects | violations audit | manques mineurs |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const c of ['C1', 'C2', 'C3']) {
    const r = m.byCohort[c] ?? { n: 0, ok: 0, hard: 0, soft: 0 };
    L.push(`| ${c} | ${r.n} | ${r.ok} | ${r.hard} | ${r.soft} |`);
  }
  L.push('');
  L.push(`## Matrice de confusion (lignes = attendu, colonnes = prédit)`);
  L.push('');
  L.push(`| attendu \\ prédit | ${CLASSES.join(' | ')} |`);
  L.push(`| --- | ${CLASSES.map(() => ' --- ').join(' | ')} |`);
  for (const row of CLASSES) {
    L.push(`| **${row}** | ${CLASSES.map((col) => String(m.confusion[row][col])).join(' | ')} |`);
  }
  L.push('');
  if (m.confidenceBands.length > 0) {
    L.push(`## Bandes de confiance des propositions`);
    L.push('');
    L.push(`| Bande | correctes | fausses |`);
    L.push(`| --- | --- | --- |`);
    for (const b of m.confidenceBands) L.push(`| ${b.band} | ${b.correct} | ${b.wrong} |`);
    L.push('');
  }
  L.push(`## Performance et coût (critères kill de l'étude)`);
  L.push('');
  L.push(`- Médiane : ${m.perf.medianMs.toFixed(4)} ms/op — p95 : ${m.perf.p95Ms.toFixed(4)} ms/op — débit : ${Math.round(m.perf.opsPerSec)} op/s`);
  L.push(`- Coût calcul : **${m.cost.eurPerOp.toExponential(2)} €/opération** (plafond immédiat : ${m.cost.ceilingNow} € — ${m.cost.verdictNow} ; trajectoire : ${m.cost.ceilingTrajectory} € — ${m.cost.verdictTrajectory})`);
  L.push(`- Hypothèse : ${m.cost.assumption}`);
  L.push(`- Appels LLM : ${m.perf.llmCalls} (le seul risque réaliste de dépasser 0,10 €/op est d'ajouter des appels LLM par opération — à budgéter par exception, jamais par opération).`);
  L.push('');
  if (m.phase2Backlog.length > 0) {
    L.push(`## Backlog phase 2 (réservé au moteur avancé)`);
    L.push('');
    for (const b of m.phase2Backlog) {
      const qualif = b.lockedCount === b.cases.length
        ? 'verrouillés — v0.1 doit s\'abstenir'
        : `dont ${b.cases.length - b.lockedCount} témoin déverrouillé, résolu en v0.1 comme paiement partiel (phase 2 doit reconnaître la déduction)`;
      L.push(`- **${b.label}** — ${b.cases.length} cas ${qualif} : ${b.cases.join(', ')}`);
    }
    L.push('');
  }
  if (m.lockedProposals.length > 0) {
    L.push(`## ⚠ Propositions illégales sur cas verrouillés`);
    L.push('');
    for (const id of m.lockedProposals) L.push(`- ${id}`);
    L.push('');
  }
  return L.join('\n');
}

// ── CLI ───────────────────────────────────────────────────────────────────────
export async function main(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const fileConfig = JSON.parse(readFileSync(join(here, '../benchmark.config.json'), 'utf8')) as BenchConfig;
  const config = fileConfig;
  const enginePath = isAbsolute(config.engine) ? config.engine : join(here, '../', config.engine);
  const engine = await loadEngine(enginePath, config);
  const result = runBenchmark({ engine, config: { ...config, engineName: config.engineName } });

  const reportDir = isAbsolute(config.reportDir) ? config.reportDir : join(here, '../', config.reportDir);
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'benchmark-report.json'), result.reportJson, 'utf8');
  writeFileSync(join(reportDir, 'benchmark-report.md'), result.reportMd, 'utf8');

  const m = result.metrics;
  const lines = [
    `Moteur : ${m.engineName}`,
    `Cas : ${m.totals.cases} — corrects ${m.totals.ok}, violations audit ${m.totals.hard}, mineurs ${m.totals.soft}`,
    `Précision : ${pct(m.precision)} — Résolution : ${pct(m.resolution.rate)}`,
    `Gates : AUDIT=${m.gates.audit ? 'PASS' : 'FAIL'}  C1=${m.gates.c1Exact ? 'PASS' : 'FAIL'}  C3-discipline=${m.gates.c3Discipline ? 'PASS' : 'FAIL'}  LLM=${m.gates.llmFree ? 'PASS' : 'FAIL'}`,
    `Perf : médiane ${m.perf.medianMs.toFixed(4)} ms/op, ${Math.round(m.perf.opsPerSec)} op/s`,
    `Coût : ${m.cost.eurPerOp.toExponential(2)} €/op (plafonds ${m.cost.ceilingNow}€ / ${m.cost.ceilingTrajectory}€ : ${m.cost.verdictNow}/${m.cost.verdictTrajectory})`,
    `Rapport : ${join(reportDir, 'benchmark-report.md')}`,
  ];
  console.log(lines.join('\n'));
  process.exitCode = m.gates.audit && m.gates.c1Exact && m.gates.c3Discipline ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolveArgv1(process.argv[1])) {
  void main();
}
function resolveArgv1(p: string): string {
  try { return fileURLToPath(p); } catch { return resolve(p); }
}
