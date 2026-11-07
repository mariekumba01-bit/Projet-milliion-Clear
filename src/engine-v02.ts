// ─────────────────────────────────────────────────────────────────────────────
// ClearMatch moteur v0.2 — couche phase 2 par-dessus le moteur de référence v0.1.
//
// Le v0.1 (src/engine.ts) reste l'arbitre du terrain natif et de la discipline ;
// le v0.2 ajoute UNIQUEMENT des résolutions que le v0.1 signalait sans les traiter :
//   P1 — ventilation des virements groupés (somme exacte / escompte 2 % / prorata 5–95 %)
//   P2 — déduction reconnue (écart = 2 % exactement de la facture, avec ou sans indice textuel)
//   P3 — paiement partiel sans référence (acompte lu dans le libellé, facture ouverte unique)
//   P4 — ventilation libre (combinaison unique de factures sommant au montant, sans référence)
//   P5 — doublon de facture confirmé (même numéro, même montant, même client)
//   P6 — doublon de paiement probable (jumeau dans le lot d'import, ± 3 jours)
//
// Invariants conservés : requiresHuman = true, llmCalls = 0, aucune écriture,
// aucune proposition approximative — si la résolution exacte n'existe pas, on garde
// le résultat v0.1 (flag/abstention) et on le documente.
// ─────────────────────────────────────────────────────────────────────────────
import { createEngine as createV01, dayDiff, detectCustomer, findRefHits, fmtEur, norm } from './engine.ts';
import type {
  BreakdownEntry, Candidate, Classification, Engine, EngineConfig, EngineContext,
  EngineResult, Evidence, Invoice, Payment, Proposal,
} from './types.ts';

export const PHASE2_VERSION = 'clearmatch-phase2-v0.2';

const TWIN_WINDOW_DAYS = 3;   // jumeau de virement : même client, même montant, ± 3 jours
const SUBSET_MAX = 12;        // au-delà de 12 factures ouvertes, pas de recherche exhaustive

/** Sous-ensembles (taille ≥ 2) dont la somme égale exactement la cible, en centimes. */
function subsetSums(invs: Invoice[], target: number): Invoice[][] {
  const found: Invoice[][] = [];
  const n = invs.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    let bits = 0, x = mask;
    while (x) { bits += x & 1; x >>= 1; }
    if (bits < 2) continue;
    let s = 0;
    const picked: Invoice[] = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) { s += invs[i].amountCents; picked.push(invs[i]); }
    if (s === target) found.push(picked);
  }
  return found;
}

/** Ventilation d'un virement groupé. k : entier 1..19 pour le prorata (taux = k/20) — arithmétique entière partagée avec le fuzz, pas de flottant. */
function groupedBreakdown(hits: Invoice[], mode: 'sum' | 'ded' | 'prorata', k: number): BreakdownEntry[] {
  return hits.map((inv) => {
    const assigned = mode === 'sum'
      ? inv.amountCents
      : mode === 'ded'
        ? inv.amountCents - Math.round(inv.amountCents * 0.02)
        : Math.round(inv.amountCents * k / 20);
    return { invoiceId: inv.id, invoiceNumber: inv.number, assignedCents: assigned, residualCents: inv.amountCents - assigned };
  });
}

// ── Moteur ────────────────────────────────────────────────────────────────────
export interface Phase2Engine extends Engine {}

export function createEngine(_config?: EngineConfig): Phase2Engine {
  const v01 = createV01(_config);
  return {
    process(payment: Payment, openInvoices: Invoice[], context: EngineContext): EngineResult {
      const r1 = v01.process(payment, openInvoices, context);
      const label = norm(payment.label);
      const cfg = context.config;
      const refHits = findRefHits(label, openInvoices);
      const customer = detectCustomer(label, context.customers);
      const base = (decision: EngineResult['decision'], classification: Classification, notes: string[], candidates: Candidate[]): EngineResult =>
        ({ paymentId: payment.id, requiresHuman: true as const, decision, classification, proposal: null, candidates, notes, llmCalls: 0 });
      const hasNote = (frag: string) => r1.notes.some((n) => n.includes(frag));

      // ── P1 — ventilation des virements groupés (v0.1 : flag multi_reference_grouped) ──
      if (r1.decision === 'flag' && r1.classification === 'multi_reference_grouped' && refHits.length >= 2) {
        const hits = refHits;
        const pay = payment.amountCents;
        const sum = hits.reduce((a, i) => a + i.amountCents, 0);
        if (!hits.every((i) => i.currency === payment.currency)) {
          r1.notes.push('phase 2 : devises hétérogènes dans le groupe — rapprochement impossible sans vérification humaine');
        } else {
          let mode: 'sum' | 'ded' | 'prorata' | null = null;
          let prorataK = 0;
          if (pay === sum) mode = 'sum';
          else if (groupedBreakdown(hits, 'ded', 0).reduce((a, b) => a + b.assignedCents, 0) === pay) mode = 'ded';
          else {
            for (let k = 1; k <= 19; k++) {
              if (groupedBreakdown(hits, 'prorata', k).reduce((a, b) => a + b.assignedCents, 0) === pay) { mode = 'prorata'; prorataK = k; break; }
            }
          }
          if (mode) {
            const breakdown = groupedBreakdown(hits, mode, prorataK);
            const residualTotal = breakdown.reduce((a, b) => a + b.residualCents, 0);
            const nums = hits.map((i) => i.number).join(' + ');
            const firstDue = hits.map((i) => i.dueDate).sort()[0];
            const dateGapDays = Math.round(dayDiff(payment.date, firstDue));
            const dateEvidence: Evidence = { kind: 'date_window', detail: `écart de ${dateGapDays} j avec la première échéance du groupe (fenêtre ${cfg.dateWindowDays} j)` };
            const confidence = mode === 'sum' ? 0.9 : mode === 'ded' ? 0.85 : 0.8;
            const evidence: Evidence[] = [
              { kind: 'references_in_label', detail: `${hits.length} références lues dans le libellé : ${nums}` },
              mode === 'sum'
                ? { kind: 'exact_group_sum', detail: `somme des ${hits.length} factures = montant du virement (${fmtEur(pay)})` }
                : mode === 'ded'
                  ? { kind: 'deduction_justified', detail: `déduction de 2 % reconnue sur le groupe : chaque facture est réglée à 98 % (écart total ${fmtEur(sum - pay)})` }
                  : { kind: 'proportional_split', detail: `ventilation au prorata : taux uniforme de ${prorataK * 5} % (k = ${prorataK}/20) appliqué à chaque facture` },
              dateEvidence,
            ];
            const explanation = mode === 'sum'
              ? `Virement groupé : la somme des ${hits.length} factures (${nums}) égale exactement le montant reçu — ventilation proposée, validation humaine requise.`
              : mode === 'ded'
                ? `Virement groupé avec déduction de 2 % : chaque facture est réglée à 98 % de son montant (écart total ${fmtEur(sum - pay)}) — ventilation proposée, validation humaine requise.`
                : `Virement groupé au prorata : taux uniforme de ${prorataK * 5} % appliqué aux ${hits.length} factures — ventilation proposée, validation humaine requise.`;
            const proposal: Proposal = {
              invoiceId: breakdown[0].invoiceId, // première facture du groupe ; le détail complet vit dans breakdown
              assignedAmountCents: pay, residualCents: residualTotal, confidence, evidence, explanation, breakdown,
            };
            const r2 = base('proposal', 'multi_reference_grouped', [...r1.notes, 'virement groupé ventilé en phase 2 — vérifier chaque ligne avant validation'], hits.map((i) => ({ invoiceId: i.id, score: 0.7, reason: 'référence lue dans le libellé' })));
            r2.proposal = proposal;
            return r2;
          }
          r1.notes.push('phase 2 : aucune ventilation exacte trouvée (somme, escompte 2 %, prorata 5–95 %) — vérification humaine requise, aucun montant affecté');
        }
      }

      // ── P2 — déduction de 2 % reconnue (v0.1 : flag amount_mismatch ou partiel) ──
      if (refHits.length === 1 && (r1.classification === 'amount_mismatch' || (r1.decision === 'proposal' && r1.classification === 'matched_partial'))) {
        const inv = refHits[0];
        const gap = inv.amountCents - payment.amountCents;
        const currencyOk = inv.currency === payment.currency;
        const customerOk = !customer || norm(customer) === norm(inv.customer);
        if (currencyOk && customerOk && gap === Math.round(inv.amountCents * 0.02)) {
          const hint = /ESCOMPTE/.test(label) ? 'escompte' : /REMISE/.test(label) ? 'remise' : null;
          const confidence = hint ? 0.9 : 0.85;
          const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
          const evidence: Evidence[] = [
            { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
            { kind: 'deduction_justified', detail: hint
              ? `« ${hint.toUpperCase()} » lu dans le libellé et écart = 2 % exactement de la facture (${fmtEur(gap)})`
              : `écart de ${fmtEur(gap)} = 2 % exactement de la facture, sans indice textuel — déduction reconnue par le ratio` },
            { kind: 'amount_after_deduction', detail: `reçu ${fmtEur(payment.amountCents)} = facture ${fmtEur(inv.amountCents)} − 2 %` },
            { kind: 'date_window', detail: `écart de ${dateGapDays} j avec l'échéance (fenêtre ${cfg.dateWindowDays} j)` },
          ];
          const proposal: Proposal = {
            invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0, confidence, evidence,
            explanation: hint
              ? `Déduction de 2 % reconnue sur la facture ${inv.number} (${hint} signalé dans le libellé) — affectation proposée au montant reçu, validation humaine requise.`
              : `Écart de ${fmtEur(gap)} = exactement 2 % de la facture ${inv.number}, sans indice textuel — déduction reconnue par le ratio, validation humaine requise.`,
          };
          const r2 = base('proposal', 'matched_exact', [...r1.notes, 'déduction de 2 % reconnue en phase 2 — conserver le justificatif (escompte/remise) attaché au lettrage'], []);
          r2.proposal = proposal;
          return r2;
        }
      }

      // ── P3/P4 — abstention « ventilation ou paiement partiel » (v0.1 : R4 sans correspondance) ──
      if (r1.decision === 'abstain' && r1.classification === 'unmatched_no_candidate' && customer && hasNote('ventilation ou paiement partiel')) {
        const own = openInvoices.filter((i) => norm(i.customer) === norm(customer) && i.currency === payment.currency);
        const pay = payment.amountCents;
        // P3 — acompte sans référence : une seule facture ouverte, libellé qui dit ACOMPTE
        if (own.length === 1 && pay < own[0].amountCents && /ACOMPTE/.test(label)) {
          const inv = own[0];
          const gap = inv.amountCents - pay;
          const ratio = pay / inv.amountCents;
          if (gap > cfg.feeGapMaxCents && ratio >= 0.1) {
            const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
            const evidence: Evidence[] = [
              { kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer}), facture ouverte unique` },
              { kind: 'partial_hint', detail: `« ACOMPTE » lu dans le libellé` },
              { kind: 'partial_amount', detail: `reçu ${fmtEur(pay)} sur une facture de ${fmtEur(inv.amountCents)}` },
              { kind: 'date_window', detail: `écart de ${dateGapDays} j avec l'échéance (fenêtre ${cfg.dateWindowDays} j)` },
            ];
            const proposal: Proposal = {
              invoiceId: inv.id, assignedAmountCents: pay, residualCents: gap, confidence: 0.7, evidence,
              explanation: `Paiement partiel sans référence (acompte) sur la facture ${inv.number} — reste à recevoir : ${fmtEur(gap)}. Validation humaine requise.`,
            };
            const r2 = base('proposal', 'matched_partial', [...r1.notes, 'paiement partiel sans référence — proposé uniquement parce que le client n\'a qu\'une seule facture ouverte et que le libellé mentionne un acompte ; vérifier avec le client'], []);
            r2.proposal = proposal;
            return r2;
          }
        }
        // P4 — ventilation libre : combinaison unique de factures sommant au montant
        if (own.length >= 2 && own.length <= SUBSET_MAX) {
          const combos = subsetSums(own, pay);
          if (combos.length === 1) {
            const picked = combos[0];
            const breakdown: BreakdownEntry[] = picked.map((inv) => ({ invoiceId: inv.id, invoiceNumber: inv.number, assignedCents: inv.amountCents, residualCents: 0 }));
            const nums = picked.map((i) => i.number).join(' + ');
            const firstDue = picked.map((i) => i.dueDate).sort()[0];
            const dateGapDays = Math.round(dayDiff(payment.date, firstDue));
            const evidence: Evidence[] = [
              { kind: 'customer_consistency', detail: `client du libellé = ${customer}` },
              { kind: 'unique_subset_sum', detail: `seule combinaison des factures ouvertes sommant à ${fmtEur(pay)} : ${nums} (testées ${2 ** own.length - own.length - 1} combinaisons)` },
              { kind: 'date_window', detail: `écart de ${dateGapDays} j avec la première échéance (fenêtre ${cfg.dateWindowDays} j)` },
            ];
            const proposal: Proposal = {
              invoiceId: picked[0].id, assignedAmountCents: pay, residualCents: 0, confidence: 0.8, evidence,
              explanation: `Ventilation sans référence : seule combinaison des factures ouvertes de ${customer} sommant au montant reçu (${nums}) — validation humaine requise.`,
              breakdown,
            };
            const r2 = base('proposal', 'multi_reference_grouped', [...r1.notes, 'ventilation libre sans référence — combinaison unique, aucune affectation approximative'], picked.map((i) => ({ invoiceId: i.id, score: 0.6, reason: 'membre de la combinaison unique' })));
            r2.proposal = proposal;
            return r2;
          }
          if (combos.length >= 2) {
            const union = [...new Map(combos.flat().map((i) => [i.id, i])).values()];
            return base('flag', 'ambiguous',
              [...r1.notes, `phase 2 : ${combos.length} combinaisons de factures ouvertes somment au montant — demander la ventilation au client, aucune affectation`],
              union.map((i) => ({ invoiceId: i.id, score: 0.5, reason: 'combinaison possible de factures sommant au montant' })));
          }
        }
      }

      // ── P5 — doublon de facture confirmé (v0.1 : ambiguous « doublon possible ») ──
      if (r1.decision === 'flag' && r1.classification === 'ambiguous' && hasNote('doublon de facture possible') && refHits.length >= 2) {
        const sameAmount = refHits.every((i) => i.amountCents === refHits[0].amountCents);
        const sameCustomer = refHits.every((i) => norm(i.customer) === norm(refHits[0].customer));
        if (sameAmount && sameCustomer && refHits.every((i) => i.currency === refHits[0].currency)) {
          r1.notes.push('phase 2 : doublon de facture confirmé (même numéro, même montant, même client) — double saisie probable : lettrer une seule facture et faire corriger l\'autre ; aucune affectation automatique');
        } else {
          r1.notes.push('phase 2 : même numéro mais données divergentes (montant ou client) — incohérence de saisie à corriger avant lettrage');
        }
      }

      // ── P6 — doublon de paiement probable (jumeau dans le lot d'import) ──
      if (r1.decision === 'flag' && r1.classification === 'ambiguous' && customer && hasNote('plusieurs factures ouvertes de même montant') && context.batchPayments) {
        const twins = context.batchPayments.filter((p) =>
          p.id !== payment.id
          && p.amountCents === payment.amountCents
          && p.currency === payment.currency
          && dayDiff(p.date, payment.date) <= TWIN_WINDOW_DAYS
          && detectCustomer(norm(p.label), context.customers) === customer);
        if (twins.length >= 1) {
          r1.notes.push(`phase 2 : doublon de paiement probable — ${1 + twins.length} virements identiques du même client (même montant, même jour ± ${TWIN_WINDOW_DAYS} j : ${twins.map((t) => t.id).join(', ')}) : vérifier avec le client (double virement ou règlement de deux factures distinctes) ; aucune affectation automatique`);
        }
      }

      return r1; // aucune règle phase 2 n'a produit de résultat : le verdict v0.1 fait foi
    },
  };
}

export default { createEngine, PHASE2_VERSION };
