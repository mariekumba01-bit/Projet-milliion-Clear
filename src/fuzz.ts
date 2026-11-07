// ─────────────────────────────────────────────────────────────────────────────
// ClearMatch Fuzz — suite réaliste à grande échelle pour le moteur v0.2.
//
// Le dataset 114 cas est façonné à la main ; cette suite mesure le moteur sur un
// volume et un bruit réalistes :
//   • ~9 000 opérations générées de façon DÉTERMINISTE (PRNG semé — reproductible) ;
//   • bruit de saisie bancaire : NBSP, minuscules, « N° », espaces dans les
//     numéros, préfixe absent, zéros de tête ;
//   • pièges : fausses références (transposition de chiffres), libellés nus,
//     paiements sans correspondance — le moteur doit s'abstenir (porte audit) ;
//   • paires de jumeaux (doublons de virement) gardées dans le même lot
//     d'import pour la détection phase 2 ;
//   • portes : AUDIT (zéro faux appariement), RÉSOLUTION ≥ 95 %, perf, coût.
//
// Aucune donnée de production : les montants, noms et numéros sont générés —
// le fuzz mesure le comportement du moteur, pas la réalité d'un portefeuille.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEngine } from './engine-v02.ts';
import { findRefHits, norm } from './engine.ts';
import type { Engine, EngineConfig, EngineContext, EngineResult, Invoice, Payment } from './types.ts';

// ── PRNG déterministe (mulberry32) ────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
type Rng = () => number;
const ri = (rng: Rng, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));
const pick = <T,>(rng: Rng, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];

// ── Paramètres ────────────────────────────────────────────────────────────────
const here = dirname(fileURLToPath(import.meta.url));
const fileConfig = JSON.parse(readFileSync(join(here, '../benchmark.config.json'), 'utf8')) as {
  computeEurPerHour: number; killCeilings: { nowEurPerOp: number; trajectoryEurPerOp: number };
};
const CONFIG: EngineConfig = { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 };
const BATCH_SIZE = 60;
const BASE_DATE = Date.parse('2027-01-15');
const d = (offset: number): string => new Date(BASE_DATE + offset * 86_400_000).toISOString().slice(0, 10);

// ── Génération du portefeuille (clients + factures ouvertes) ──────────────────
const PRE = ['SARL', 'SAS', 'Groupe', 'Atelier', 'Distribution', 'Comptoir', 'Cabinet', 'Entrepôt', 'Sté', 'Maison'] as const;
const CORE = ['Delmas', 'Novatek', 'Vermeulen', 'Balland', 'Omeda', 'Lemoine', 'Salomon', 'Lagon', 'Marais', 'Rouvière',
  'Phare', 'Couture', 'Lorrain', 'Lavaux', 'Gaël', 'Anjou', 'Meunier', 'Vignon', 'Dupré', 'Millet',
  'Tanneurs', 'Hêtre', 'Vasseur', 'Maline', 'Garnier', 'Plaza', 'Aubert', 'Belle Rive', 'Mirabeau', 'Cèdre'] as const;
const SUF = ['Plomberie', 'Bâtiment', 'Distribution', 'Conseil', 'Élevage', 'Imprimerie', 'Menuiserie', 'Transport',
  'Jardinage', 'Optique', 'Textile', 'Piscines'] as const;

function uniqueNames(count: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let i = 0;
  while (out.length < count) {
    // indexage bijectif : PRE[i%10] × CORE[floor(i/10)%30] × SUF[floor(i/300)%12] → 3600 noms distincts
    const n = `${PRE[i % PRE.length]} ${CORE[Math.floor(i / PRE.length) % CORE.length]} ${SUF[Math.floor(i / (PRE.length * CORE.length)) % SUF.length]}`;
    if (!seen.has(n)) { seen.add(n); out.push(n); }
    i++;
    if (i > count * 20) throw new Error('stock de noms épuisé — allonger CORE/SUF');
  }
  return out;
}

/** Sous-ensembles (≥ 2 factures) sommant exactement à la cible — même logique que le moteur. */
function subsetSums(invs: Invoice[], target: number): Invoice[][] {
  const found: Invoice[][] = [];
  for (let mask = 0; mask < 1 << invs.length; mask++) {
    let bits = 0, x = mask;
    while (x) { bits += x & 1; x >>= 1; }
    if (bits < 2) continue;
    let s = 0; const picked: Invoice[] = [];
    for (let i = 0; i < invs.length; i++) if (mask & (1 << i)) { s += invs[i].amountCents; picked.push(invs[i]); }
    if (s === target) found.push(picked);
  }
  return found;
}

interface World {
  customers: string[];
  openInvoices: Invoice[];
  byCustomer: Map<string, Invoice[]>;
}

// ── Intents (chaque paiement généré connaît sa vérité terrain) ────────────────
type FuzzExpectation =
  | { t: 'proposal'; classification: string; invoiceId?: string; residualCents?: number; breakdown?: Map<string, { assigned: number; residual: number }> }
  | { t: 'flag'; classification: string; noteContains?: string }
  | { t: 'abstain'; classification: string };
interface Intent {
  kind: string;
  payment: Payment;
  groupId: number | null; // non-null = membre d'une paire à garder dans le même lot
  expected: FuzzExpectation;
}
interface Batch { payments: Payment[]; intents: Intent[]; }

let invSeq = 0, paySeq = 0, groupSeq = 0;
const nextInv = (customer: string, amountCents: number, world: World): Invoice => {
  const inv: Invoice = {
    id: `inv-fuzz-${String(++invSeq).padStart(4, '0')}`,
    number: `FA2027-${String(1000 + invSeq).padStart(4, '0')}`,
    customer, customerReference: null, amountCents, currency: 'EUR',
    issueDate: d(-45), dueDate: d(ri(mulberry32(invSeq), 5, 40)), open: true,
  };
  world.openInvoices.push(inv);
  (world.byCustomer.get(customer) ?? world.byCustomer.set(customer, []).get(customer)!).push(inv);
  return inv;
};
const nextPay = (label: string, amountCents: number, day: number, currency: 'EUR' | 'USD' = 'EUR'): Payment =>
  ({ id: `pay-fuzz-${String(++paySeq).padStart(4, '0')}`, label, amountCents, currency, date: d(day) });

// bruit de saisie sur un libellé canonique « FACT {num} »
function noisyFact(rng: Rng, num: string, customer: string | null): string {
  const c = customer ?? '';
  const head = customer ? `VIR SEPA RECU DE ${c.toUpperCase()} ` : 'VIR RECU ';
  const tail = pick(rng, [
    `FACT ${num}`,
    `FACT\u00a0${num}`,
    `fact ${num.toLowerCase()}`,
    `FACT N° ${num.replace(/^FA/, '')}`,
    `FACT ${num.replace(/^FA/, 'FA ')}`,
    `FACT ${num.replace(/^FA/, 'FA ').replace('-', ' ')}`,
  ] as const);
  return `${head}${tail}`;
}

function generate(rng: Rng, ops: number): { world: World; intents: Intent[] } {
  // pool A : clients « lecture seule » ; pool B : clients dédiés aux doublons
  const poolA = uniqueNames(460);
  const poolB = uniqueNames(460 + 320).slice(460);
  const world: World = { customers: [...poolA, ...poolB], openInvoices: [], byCustomer: new Map() };
  for (const c of poolA) {
    const n = pick(rng, [1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 5, 6]); // 1 à 6 factures ouvertes
    for (let k = 0; k < n; k++) nextInv(c, ri(rng, 60_000, 500_000), world);
  }
  const intents: Intent[] = [];
  // sélecteurs dynamiques : clients ayant au moins 1 facture (le pool B s'enrichit au fil des cas)
  const oneOf = (c: string) => world.byCustomer.get(c)!;
  const active = (): string[] => [...world.byCustomer.keys()];
  const multiArr = (): string[] => [...world.byCustomer.entries()].filter(([, l]) => l.length >= 2).map(([k]) => k);
  const singlesArr = (): string[] => [...world.byCustomer.entries()].filter(([, l]) => l.length === 1).map(([k]) => k);
  const proportions: Array<[string, number]> = [
    ['exact', 0.40], ['partial_ref', 0.10], ['grouped_sum', 0.06], ['grouped_ded', 0.03], ['grouped_prorata', 0.03],
    ['free_subset', 0.04], ['ded2', 0.04], ['acompte', 0.03], ['fee', 0.03], ['usd', 0.02], ['negatif', 0.03],
    ['twin', 0.02], ['piege', 0.04], ['bare', 0.03], ['no_match', 0.02], ['dup_invoice', 0.02],
  ];
  const counts = new Map<string, number>(proportions.map(([k, p]) => [k, Math.round(p * ops)]));

  for (const [kind, count] of counts) {
    for (let i = 0; i < count; i++) {
      switch (kind) {
        case 'exact': {
          const c = pick(rng, active());
          const invs = oneOf(c); const inv = pick(rng, invs);
          const withCustomer = rng() < 0.8;
          const p = nextPay(noisyFact(rng, inv.number, withCustomer ? c : null), inv.amountCents, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'matched_exact', invoiceId: inv.id, residualCents: 0 } });
          break;
        }
        case 'partial_ref': {
          const c = pick(rng, active()); const invs = oneOf(c); const inv = pick(rng, invs);
          let pay = 0, gap = 0;
          do { pay = Math.round(inv.amountCents * (0.4 + rng() * 0.45)); gap = inv.amountCents - pay; }
          while (gap <= CONFIG.feeGapMaxCents || gap === Math.round(inv.amountCents * 0.02));
          const p = nextPay(noisyFact(rng, inv.number, rng() < 0.8 ? c : null), pay, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'matched_partial', invoiceId: inv.id, residualCents: gap } });
          break;
        }
        case 'grouped_sum':
        case 'grouped_ded':
        case 'grouped_prorata': {
          const m = multiArr();
          if (!m.length) { i--; break; }
          const c = pick(rng, m); const invs = oneOf(c);
          if (invs.length < 2) { i--; break; }
          const size = Math.min(invs.length, 2 + (rng() < 0.3 ? 1 : 0));
          const chosen: Invoice[] = [];
          const pool = [...invs];
          while (chosen.length < size && pool.length) chosen.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
          const sum = chosen.reduce((a, x) => a + x.amountCents, 0);
          let pay: number;
          let k = 0; // prorata : entier 1..19, taux = k/20 — arithmétique entière partagée avec le moteur
          if (kind === 'grouped_sum') pay = sum;
          else if (kind === 'grouped_ded') pay = chosen.reduce((a, x) => a + x.amountCents - Math.round(x.amountCents * 0.02), 0);
          else { k = pick(rng, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]); pay = chosen.reduce((a, x) => a + Math.round(x.amountCents * k / 20), 0); }
          const label = `VIR SEPA RECU DE ${c.toUpperCase()} REGLEMENT FACT ${chosen.map((x) => x.number).join(' + ')}`;
          const p = nextPay(label, pay, ri(rng, 5, 40));
          const breakdown = new Map(chosen.map((x) => {
            const assigned = kind === 'grouped_sum' ? x.amountCents : kind === 'grouped_ded' ? x.amountCents - Math.round(x.amountCents * 0.02) : Math.round(x.amountCents * k / 20);
            return [x.id, { assigned, residual: x.amountCents - assigned }] as [string, { assigned: number; residual: number }];
          }));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'multi_reference_grouped', breakdown } });
          break;
        }
        case 'free_subset': {
          const m = multiArr();
          if (!m.length) { i--; break; }
          const c = pick(rng, m); const invs = oneOf(c);
          if (invs.length < 2) { i--; break; }
          // tirer une combinaison (2-3 factures) unique pour ce client, et distincte de tout montant simple
          let combo: Invoice[] | null = null; let target = 0;
          for (let tries = 0; tries < 25 && !combo; tries++) {
            const pool = [...invs]; const cur: Invoice[] = [];
            const size = Math.min(invs.length, 2 + (rng() < 0.3 ? 1 : 0));
            while (cur.length < size && pool.length) cur.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]);
            const s = cur.reduce((a, x) => a + x.amountCents, 0);
            if (subsetSums(invs, s).length === 1 && !invs.some((x) => x.amountCents === s)) { combo = cur; target = s; }
          }
          if (!combo) { i--; break; }
          const p = nextPay(`VIR RECU ${c.toUpperCase()}`, target, ri(rng, 5, 40));
          const breakdown = new Map(combo.map((x) => [x.id, { assigned: x.amountCents, residual: 0 }] as [string, { assigned: number; residual: number }]));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'multi_reference_grouped', breakdown } });
          break;
        }
        case 'ded2': {
          const c = pick(rng, active()); const invs = oneOf(c); const inv = pick(rng, invs);
          const gap = Math.round(inv.amountCents * 0.02);
          const hint = rng() < 0.5 ? (rng() < 0.5 ? ' ESCOMPTE 2 PCT' : ' REMISE 2 PCT') : '';
          const p = nextPay(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${inv.number}${hint}`, inv.amountCents - gap, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'matched_exact', invoiceId: inv.id, residualCents: 0 } });
          break;
        }
        case 'acompte': {
          const s = singlesArr();
          if (!s.length) { i--; break; }
          const c = pick(rng, s); const inv = oneOf(c)[0];
          const pay = Math.round(inv.amountCents * (0.3 + rng() * 0.3));
          const p = nextPay(`VIR RECU ${c.toUpperCase()} ACOMPTE`, pay, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'proposal', classification: 'matched_partial', invoiceId: inv.id, residualCents: inv.amountCents - pay } });
          break;
        }
        case 'fee': {
          const c = pick(rng, active()); const invs = oneOf(c); const inv = pick(rng, invs);
          const gap = ri(rng, 100, CONFIG.feeGapMaxCents);
          const p = nextPay(noisyFact(rng, inv.number, c), inv.amountCents - gap, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'flag', classification: 'amount_mismatch', noteContains: 'frais bancaires ou déduction' } });
          break;
        }
        case 'usd': {
          const c = pick(rng, active()); const invs = oneOf(c); const inv = pick(rng, invs);
          const p = nextPay(`INCOMING WIRE USD REF ${inv.number}`, inv.amountCents, ri(rng, 5, 40), 'USD');
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'flag', classification: 'currency_mismatch' } });
          break;
        }
        case 'negatif': {
          const c = pick(rng, active());
          const p = nextPay(`REJET PRLV ${c.toUpperCase()}`, -ri(rng, 2_000, 90_000), ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'flag', classification: 'rejected_or_reversal' } });
          break;
        }
        case 'twin': {
          // pool B dédié : client avec exactement 2 factures de même montant, 2 virements identiques
          const c = poolB[Math.floor(i / 2) % poolB.length];
          const amount = ri(rng, 60_000, 300_000);
          const i1 = nextInv(c, amount, world); const i2 = nextInv(c, amount, world);
          const day = ri(rng, 5, 40);
          const groupId = ++groupSeq;
          const p1 = nextPay(`VIR RECU ${c.toUpperCase()}`, amount, day);
          const p2 = nextPay(`VIR RECU ${c.toUpperCase()}`, amount, day);
          intents.push({ kind, payment: p1, groupId, expected: { t: 'flag', classification: 'ambiguous', noteContains: 'doublon de paiement probable', } });
          intents.push({ kind, payment: p2, groupId, expected: { t: 'flag', classification: 'ambiguous', noteContains: 'doublon de paiement probable' } });
          void i1; void i2;
          break;
        }
        case 'piege': {
          const c = pick(rng, active()); const invs = oneOf(c); const inv = pick(rng, invs);
          // transposition de deux chiffres du numéro : ne doit correspondre à AUCUNE facture
          // — y compris via les variantes de motifs du moteur (préfixe optionnel, séparateurs,
          // zéros de tête) : le garde-fou utilise la sémantique EXACTE du moteur (findRefHits).
          // La transposition ne porte QUE sur la partie numérique propre (après « FA2027- ») :
          // inclure le préfixe produirait des libellés dégénérés (année dupliquée) que le moteur
          // lit légitimement comme « année + numéro ».
          const digits = inv.number.replace(/^.*-/, '');
          let fake = '';
          for (let tries = 0; tries < 10; tries++) {
            const k = 1 + Math.floor(rng() * (digits.length - 2));
            const arr = digits.split('');
            [arr[k], arr[k + 1]] = [arr[k + 1], arr[k]];
            const cand = `FA2027-${arr.join('')}`;
            if (cand !== inv.number && findRefHits(norm(`VIR RECU ${cand} DG`), world.openInvoices).length === 0) { fake = cand; break; }
          }
          if (!fake) { i--; break; }
          const p = nextPay(`VIR RECU ${fake} DG`, inv.amountCents, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'abstain', classification: 'unmatched_no_candidate' } });
          break;
        }
        case 'bare': {
          const p = nextPay(pick(rng, ['VIR SEPA', 'REMISE DE CHEQUES', 'VIR RECU', 'COTISATION TRIMESTRIELLE']), ri(rng, 10_000, 200_000), ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'abstain', classification: 'unmatched_no_candidate' } });
          break;
        }
        case 'no_match': {
          const m = multiArr();
          if (!m.length) { i--; break; }
          const c = pick(rng, m); const invs = oneOf(c);
          let pay = 0;
          for (let tries = 0; tries < 30; tries++) {
            pay = ri(rng, 20_000, 480_000);
            if (invs.some((x) => x.amountCents === pay)) continue;
            if (subsetSums(invs, pay).length > 0) continue;
            break;
          }
          const p = nextPay(`VIR RECU ${c.toUpperCase()}`, pay, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'abstain', classification: 'unmatched_no_candidate' } });
          break;
        }
        case 'dup_invoice': {
          // pool B dédié : deux factures identiques (même numéro, même montant), un virement qui les cite
          const c = poolB[160 + (i % 160)];
          const amount = ri(rng, 60_000, 300_000);
          const invA: Invoice = {
            id: `inv-fuzz-${String(++invSeq).padStart(4, '0')}`,
            number: `FA2027-${String(1000 + invSeq).padStart(4, '0')}`,
            customer: c, customerReference: null, amountCents: amount, currency: 'EUR',
            issueDate: d(-45), dueDate: d(20), open: true,
          };
          const invB: Invoice = { ...invA, id: `inv-fuzz-${String(++invSeq).padStart(4, '0')}` };
          world.openInvoices.push(invA, invB);
          (world.byCustomer.get(c) ?? world.byCustomer.set(c, []).get(c)!).push(invA, invB);
          const p = nextPay(`VIR SEPA RECU DE ${c.toUpperCase()} FACT ${invA.number}`, amount, ri(rng, 5, 40));
          intents.push({ kind, payment: p, groupId: null, expected: { t: 'flag', classification: 'ambiguous', noteContains: 'doublon de facture confirmé' } });
          break;
        }
      }
    }
  }
  // Validation FINALE des pièges : le monde a grandi pendant la génération (twin puis
  // dup_invoice ajoutent des factures APRÈS les pièges) — un faux numéro validé « sans
  // hit » plus tôt peut désormais matcher une paire dup (même numéro ×2 → ambiguous).
  // On rejoue donc le garde-fou contre le monde complet : tout piège qui hit désormais
  // est retiré — il n'est plus un piège par construction.
  const kept: Intent[] = [];
  for (const it of intents) {
    if (it.kind === 'piege' && findRefHits(norm(it.payment.label), world.openInvoices).length > 0) continue;
    kept.push(it);
  }
  return { world, intents: kept };
}

// ── Découpage en lots (une paire de jumeaux ne franchit jamais la frontière) ──
function makeBatches(intents: Intent[]): Batch[] {
  const batches: Batch[] = [];
  let cur: Batch = { payments: [], intents: [] };
  const groupOf = new Map<number, Batch>();
  for (const it of intents) {
    if (it.groupId != null) {
      const home = groupOf.get(it.groupId);
      if (home) { home.payments.push(it.payment); home.intents.push(it); continue; } // le jumeau rejoint son lot d'origine
      if (cur.payments.length >= BATCH_SIZE) { batches.push(cur); cur = { payments: [], intents: [] }; }
      groupOf.set(it.groupId, cur);
      cur.payments.push(it.payment); cur.intents.push(it);
      continue;
    }
    if (cur.payments.length >= BATCH_SIZE) { batches.push(cur); cur = { payments: [], intents: [] }; }
    cur.payments.push(it.payment); cur.intents.push(it);
  }
  if (cur.payments.length) batches.push(cur);
  return batches;
}

// ── Jugement ──────────────────────────────────────────────────────────────────
interface FuzzOutcome { kind: string; ok: boolean; problem: string; latencyMs: number; paymentId: string; label: string; }

function judgeIntent(it: Intent, r: EngineResult): string | null {
  const e = it.expected;
  if (e.t === 'proposal') {
    if (r.decision !== 'proposal') return `proposition attendue, reçu ${r.decision}/${r.classification}`;
    if (r.classification !== e.classification) return `classe ${r.classification} ≠ ${e.classification}`;
    if (!r.proposal) return 'proposition manquante';
    if (e.invoiceId && r.proposal.invoiceId !== e.invoiceId) return `facture ${r.proposal.invoiceId} ≠ ${e.invoiceId}`;
    if (e.residualCents != null && Math.abs(r.proposal.residualCents - e.residualCents) > 1) return `résiduel ${r.proposal.residualCents} ≠ ${e.residualCents}`;
    if (e.breakdown) {
      const got = r.proposal.breakdown;
      if (!got) return 'ventilation attendue, absente';
      const gotMap = new Map(got.map((b) => [b.invoiceId, b]));
      if (gotMap.size !== e.breakdown.size || [...e.breakdown.keys()].some((id) => !gotMap.has(id))) return 'ventilation sur les mauvaises factures';
      for (const [id, want] of e.breakdown) {
        const g = gotMap.get(id)!;
        if (g.assignedCents !== want.assigned || g.residualCents !== want.residual) return `ventilation ${id} : affecté ${g.assignedCents}/${g.residualCents} ≠ ${want.assigned}/${want.residual}`;
      }
      if (got.reduce((a, b) => a + b.assignedCents, 0) !== it.payment.amountCents) return 'la ventilation n\'affecte pas le montant du paiement';
    }
    if (r.proposal.evidence.length < 2 || !r.proposal.explanation.trim()) return 'preuves < 2 ou explication vide';
    return null;
  }
  if (r.decision === 'proposal') return 'proposition interdite ici';
  if (r.classification !== e.classification) return `classe ${r.classification} ≠ ${e.classification}`;
  if (e.t === 'flag' && e.noteContains && !r.notes.join(' | ').toLowerCase().includes(e.noteContains!.toLowerCase())) return `note attendue : « ${e.noteContains} »`;
  return null;
}

// ── Exécution + métriques + rapport ───────────────────────────────────────────
const it_proposalKinds = new Set(['exact', 'partial_ref', 'grouped_sum', 'grouped_ded', 'grouped_prorata', 'free_subset', 'ded2', 'acompte']);

export interface FuzzSummary {
  seed: number; ops: number; openInvoices: number; customers: number; batches: number;
  medianMs: number; p95Ms: number; opsPerSec: number; eurPerOp: number;
  wrong: number; proposalExpected: number; proposalOk: number;
  byKind: Array<{ kind: string; n: number; ok: number; problems: string[] }>;
}

export function runFuzz(opts?: { ops?: number; seed?: number; engine?: Engine }): {
  outcomes: FuzzOutcome[]; gates: Record<string, boolean>; summary: FuzzSummary;
} {
  const ops = opts?.ops ?? 9_000;
  const seed = opts?.seed ?? 2_026_110_7;
  const rng = mulberry32(seed);
  const engine = opts?.engine ?? createEngine(CONFIG);
  const { world, intents } = generate(rng, ops);
  const batches = makeBatches(intents);
  const outcomes: FuzzOutcome[] = [];

  for (const batch of batches) {
    const ctx: EngineContext = { customers: world.customers, config: CONFIG, batchPayments: batch.payments };
    for (const it of batch.intents) {
      const t0 = performance.now();
      const r = engine.process(it.payment, world.openInvoices, ctx);
      const latencyMs = performance.now() - t0;
      const problem = judgeIntent(it, r);
      outcomes.push({ kind: it.kind, ok: problem == null, problem: problem ?? '', latencyMs, paymentId: it.payment.id, label: it.payment.label });
    }
  }

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const medianMs = latencies[Math.floor(latencies.length / 2)] ?? 0;
  const p95Ms = latencies[Math.ceil(latencies.length * 0.95) - 1] ?? 0;
  const totalMs = latencies.reduce((a, b) => a + b, 0);
  const eurPerOp = (medianMs / 3_600_000) * fileConfig.computeEurPerHour;

  let proposalExpected = 0, proposalOk = 0;
  const byKind = new Map<string, { n: number; ok: number; problems: string[] }>();
  for (const o of outcomes) {
    const row = byKind.get(o.kind) ?? { n: 0, ok: 0, problems: [] };
    row.n += 1;
    if (o.ok) row.ok += 1; else if (row.problems.length < 3) row.problems.push(o.problem);
    byKind.set(o.kind, row);
    if (it_proposalKinds.has(o.kind)) { proposalExpected += 1; if (o.ok) proposalOk += 1; }
  }
  const wrong = outcomes.filter((o) => !o.ok).length;
  const gates = {
    audit: wrong === 0,
    resolution: proposalExpected > 0 && proposalOk / proposalExpected >= 0.95,
    perfMedian: medianMs <= 15,
    perfP95: p95Ms <= 45,
    cost: eurPerOp <= fileConfig.killCeilings.trajectoryEurPerOp,
  };
  return {
    outcomes, gates,
    summary: {
      seed, ops: outcomes.length, openInvoices: world.openInvoices.length, customers: world.customers.length,
      batches: batches.length, medianMs, p95Ms, opsPerSec: totalMs > 0 ? outcomes.length / (totalMs / 1000) : 0,
      eurPerOp, wrong, proposalExpected, proposalOk,
      byKind: [...byKind.entries()].map(([k, v]) => ({ kind: k, n: v.n, ok: v.ok, problems: v.problems })),
    },
  };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
export function main(): void {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i++) {
    const m = process.argv[i]!.match(/^--(\w+)=(.+)$/);
    if (m) args.set(m[1]!, m[2]!);
  }
  const ops = Number(args.get('ops') ?? 9_000);
  const seed = Number(args.get('seed') ?? 2_026_110_7);
  const { outcomes, gates, summary } = runFuzz({ ops, seed });

  const L: string[] = [];
  L.push('# ClearMatch Fuzz — rapport de mesure (moteur v0.2)');
  L.push('');
  L.push(`- **Moteur** : clearmatch-phase2-v0.2 — suite réaliste à grande échelle`);
  L.push(`- **Opérations** : ${summary.ops} (générées, seed ${summary.seed} — reproductible)`);
  L.push(`- **Portefeuille** : ${summary.customers} clients, ${summary.openInvoices} factures ouvertes, ${summary.batches} lots d'import (max ${BATCH_SIZE}/lot)`);
  L.push(`- **Résultat** : ${summary.ops - summary.wrong} corrects, ${summary.wrong} faux`);
  L.push('');
  L.push('## Portes');
  L.push('');
  L.push('| Porte | Critère | Verdict |');
  L.push('| --- | --- | --- |');
  L.push(`| AUDIT | zéro faux appariement / zéro proposition interdite | ${gates.audit ? '✅ PASS' : '❌ FAIL'} |`);
  L.push(`| RÉSOLUTION | ≥ 95 % des intentions résolubles proposées | ${gates.resolution ? '✅ PASS' : '❌ FAIL'} (${summary.proposalOk}/${summary.proposalExpected}) |`);
  L.push(`| PERF médiane | ≤ 15 ms/op | ${gates.perfMedian ? '✅ PASS' : '❌ FAIL'} (${summary.medianMs.toFixed(4)} ms) |`);
  L.push(`| PERF p95 | ≤ 45 ms/op | ${gates.perfP95 ? '✅ PASS' : '❌ FAIL'} (${summary.p95Ms.toFixed(4)} ms) |`);
  L.push(`| COÛT | ≤ ${fileConfig.killCeilings.trajectoryEurPerOp} €/op (trajectoire kill) | ${gates.cost ? '✅ PASS' : '❌ FAIL'} (${summary.eurPerOp.toExponential(2)} €) |`);
  L.push('');
  L.push('## Par intention');
  L.push('');
  L.push('| Intention | n | corrects | problèmes (max 3 montrés) |');
  L.push('| --- | --- | --- | --- |');
  for (const row of summary.byKind as Array<{ kind: string; n: number; ok: number; problems: string[] }>) {
    L.push(`| ${row.kind} | ${row.n} | ${row.ok} | ${row.problems.length ? row.problems.join(' ; ') : '—'} |`);
  }
  L.push('');
  L.push(`## Hypothèses`);
  L.push('');
  L.push(`- Médiane ${summary.medianMs.toFixed(4)} ms/op × ${fileConfig.computeEurPerHour} €/h de calcul (vCPU partagé) = ${summary.eurPerOp.toExponential(2)} €/op — moteur déterministe, 0 appel LLM.`);
  L.push(`- Le périmètre (${summary.openInvoices} factures ouvertes) correspond à un grand tenant (grande entreprise ou cabinet en traitement groupé) ; le coût par lot reste négligeable devant toute tarification forfaitaire.`);
  L.push(`- Débit mesuré : ${Math.round(summary.opsPerSec as number)} op/s.`);
  L.push('');
  const reportDir = join(here, '../report');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'fuzz-report.md'), L.join('\n'), 'utf8');
  writeFileSync(join(reportDir, 'fuzz-report.json'), JSON.stringify({ summary, gates, outcomes: outcomes.map((o) => ({ kind: o.kind, ok: o.ok, problem: o.problem, paymentId: o.paymentId, label: o.label, latencyMs: +o.latencyMs.toFixed(4) })) }, null, 2), 'utf8');
  console.log([
    `Fuzz v0.2 : ${summary.ops} op (seed ${summary.seed}) — corrects ${summary.ops - summary.wrong}, faux ${summary.wrong}`,
    `Gates : AUDIT=${gates.audit ? 'PASS' : 'FAIL'}  RÉSOLUTION=${gates.resolution ? 'PASS' : 'FAIL'} (${summary.proposalOk}/${summary.proposalExpected})  PERF=${gates.perfMedian && gates.perfP95 ? 'PASS' : 'FAIL'}  COÛT=${gates.cost ? 'PASS' : 'FAIL'}`,
    `Perf : médiane ${summary.medianMs.toFixed(4)} ms/op, p95 ${summary.p95Ms.toFixed(4)} ms, ${Math.round(summary.opsPerSec)} op/s — coût ${summary.eurPerOp.toExponential(2)} €/op`,
    `Rapport : ${join(reportDir, 'fuzz-report.md')}`,
  ].join('\n'));
  process.exitCode = gates.audit && gates.resolution && gates.perfMedian && gates.perfP95 && gates.cost ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolveArgv1(process.argv[1])) {
  main();
}
function resolveArgv1(p: string): string {
  try { return fileURLToPath(p); } catch { return resolve(p); }
}
