// ─────────────────────────────────────────────────────────────────────────────
// Moteur de référence ClearMatch v0.1 — reconstruit à l'identique de la spec :
//  1. détection de références de factures dans les libellés bancaires (exactes,
//     jamais approximatives — pas de rapprochement flou sur les numéros)
//  2. identification des paiements partiels (résiduel calculé)
//  3. détection des écarts de montant et de devise
//  4. détection des transactions négatives / rejetées
//  5. signalement des correspondances ambiguës (candidats classés, jamais affectés)
//  6. propositions d'affectation avec montant résiduel + preuves + explication
//  Invariant absolu : requiresHuman = true — aucune écriture, jamais.
//  Déterministe : llmCalls = 0 par construction.
// ─────────────────────────────────────────────────────────────────────────────
import type {
  Classification, Candidate, Engine, EngineConfig, EngineContext,
  EngineResult, Evidence, Invoice, Payment, Proposal,
} from './types.ts';

// ── Normalisation ─────────────────────────────────────────────────────────────
const deburr = (s: string): string => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function norm(s: string): string {
  return deburr(s).toUpperCase().replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const refRe = (pattern: string): RegExp =>
  new RegExp(`(?<![A-Z0-9])${pattern}(?![A-Z0-9])`);

/** Variantes de référence d'une facture : exactes, séparateurs optionnels, zéros tête de groupe. */
function refPatterns(inv: Invoice): string[] {
  const up = norm(inv.number);
  const m = up.match(/^([A-Z]*)(\d[\d .\-/]*\d|\d)(.*)$/);
  const patterns: string[] = [];
  if (m) {
    const [, alpha, digits, tail] = m;
    const groups = digits.split(/[ .\-/]+/).filter(Boolean);
    const sep = '[ .\\-/]?';
    if (groups.length > 1) {
      const lax = groups.map((g, i) => (i > 0 ? g.replace(/^0+/, '') : g));
      patterns.push(`${alpha}${sep}${groups.join(sep)}${tail}`);
      patterns.push(`${alpha}${sep}${lax.join(sep)}${tail}`);
      if (alpha) {
        // variantes affichées sans préfixe : « N° 2026-0142 » au lieu de « FA2026-0142 »
        patterns.push(`${sep}${groups.join(sep)}${tail}`);
        patterns.push(`${sep}${lax.join(sep)}${tail}`);
      }
    } else {
      patterns.push(`${alpha}${sep}${digits}${tail}`);
      if (alpha) patterns.push(`${sep}${digits}${tail}`);
    }
  } else {
    patterns.push(escapeRe(up));
  }
  if (inv.customerReference) patterns.push(escapeRe(norm(inv.customerReference)));
  return patterns;
}

function findRefHits(labelNorm: string, openInvoices: Invoice[]): Invoice[] {
  const hits: Invoice[] = [];
  for (const inv of openInvoices) {
    const found = refPatterns(inv).some((p) => refRe(p).test(labelNorm));
    if (found) hits.push(inv);
  }
  return hits;
}

/** Client identifiable dans le libellé (correspondance exacte de raison sociale). */
function detectCustomer(labelNorm: string, customers: string[]): string | null {
  let best: string | null = null;
  for (const c of customers) {
    const cn = norm(c);
    if (cn.length < 3) continue;
    if (refRe(escapeRe(cn)).test(labelNorm) && (!best || cn.length > norm(best).length)) best = c;
  }
  return best;
}

// ── Formatage ─────────────────────────────────────────────────────────────────
const fmtEur = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const v = Math.abs(cents);
  return `${sign}${Math.floor(v / 100).toLocaleString('fr-FR')},${String(v % 100).padStart(2, '0')} €`;
};

const dayDiff = (a: string, b: string): number =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

// ── Moteur ────────────────────────────────────────────────────────────────────
export interface ReferenceEngine extends Engine {}

export function createEngine(_config?: EngineConfig): ReferenceEngine {
  return {
    process(payment: Payment, openInvoices: Invoice[], context: EngineContext): EngineResult {
      const cfg = context.config;
      const label = norm(payment.label);
      const base = (decision: EngineResult['decision'], classification: Classification): EngineResult =>
        ({ paymentId: payment.id, requiresHuman: true as const, decision, classification, proposal: null, candidates: [], notes: [], llmCalls: 0 });

      // R0 — transaction négative : rejet/annulation, jamais proposée en rapprochement
      if (payment.amountCents < 0) {
        const r = base('flag', 'rejected_or_reversal');
        r.notes.push('transaction négative : rejet ou annulation probable — à vérifier, jamais proposée en rapprochement');
        return r;
      }

      // R1 — références exactes dans le libellé
      const refHits = findRefHits(label, openInvoices);
      const customer = detectCustomer(label, context.customers);

      // R2 — plusieurs factures touchées par le libellé
      if (refHits.length >= 2) {
        const sameNumber = new Set(refHits.map((i) => norm(i.number).replace(/[ \-/]/g, ''))).size === 1;
        if (sameNumber) {
          const r = base('flag', 'ambiguous');
          r.candidates = refHits.map((i) => ({ invoiceId: i.id, score: 0.5, reason: 'référence identique sur plusieurs factures' }));
          r.notes.push('doublon de facture possible (référence identique sur plusieurs factures ouvertes)');
          return r;
        }
        const r = base('flag', 'multi_reference_grouped');
        r.candidates = refHits.map((i) => ({ invoiceId: i.id, score: 0.7, reason: 'référence lue dans le libellé' }));
        r.notes.push(`virement groupé suspecté (${refHits.length} références distinctes) — ventilation en phase 2, aucun montant affecté`);
        return r;
      }

      // R3 — exactement une référence
      if (refHits.length === 1) {
        const inv = refHits[0];

        if (payment.currency !== inv.currency) {
          const r = base('flag', 'currency_mismatch');
          r.notes.push(`rapprochement bloqué : devise du paiement (${payment.currency}) ≠ devise de la facture (${inv.currency})`);
          return r;
        }
        if (customer && norm(customer) !== norm(inv.customer)) {
          const r = base('flag', 'ambiguous');
          r.candidates = [{ invoiceId: inv.id, score: 0.4, reason: 'référence lue mais client du libellé différent' }];
          r.notes.push(`référence trouvée chez « ${inv.customer} » alors que le libellé désigne « ${customer} » — erreur de saisie probable`);
          return r;
        }

        const gap = inv.amountCents - payment.amountCents;
        const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
        const dateEvidence: Evidence = { kind: 'date_window', detail: dateGapDays <= cfg.dateWindowDays ? `écart de ${dateGapDays} j avec l'échéance (dans la fenêtre)` : `écart de ${dateGapDays} j avec l'échéance (hors fenêtre de ${cfg.dateWindowDays} j)` };

        if (gap === 0) {
          const confidence = customer ? 0.99 : 0.9;
          const evidence: Evidence[] = [
            { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
            { kind: 'amount_exact', detail: `montant reçu = montant de la facture (${fmtEur(payment.amountCents)})` },
            dateEvidence,
          ];
          if (customer) evidence.push({ kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer})` });
          const proposal: Proposal = {
            invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0,
            confidence, evidence,
            explanation: customer
              ? `Référence ${inv.number} lue dans le libellé, montant exact et client cohérent — affectation proposée, validation humaine requise.`
              : `Référence ${inv.number} lue dans le libellé et montant exact, sans client identifiable — affectation proposée, validation humaine requise.`,
          };
          const r = base('proposal', 'matched_exact');
          r.proposal = proposal;
          if (dateGapDays > cfg.dateWindowDays) r.notes.push(`date hors fenêtre : ${dateGapDays} j de l'échéance — vérifier avec le client`);
          return r;
        }

        if (gap > 0) { // paiement < facture
          const hintDeduction = /ESCOMPTE|REMISE/.test(label);
          if (hintDeduction && gap <= Math.round(inv.amountCents * cfg.deductionHintMaxRatio)) {
            const r = base('flag', 'amount_mismatch');
            r.notes.push(`écart de ${fmtEur(gap)} avec la facture — déduction/escompte signalé dans le libellé, justificatif requis (résolution en phase 2)`);
            return r;
          }
          if (gap <= cfg.feeGapMaxCents) {
            const r = base('flag', 'amount_mismatch');
            r.notes.push(`écart de ${fmtEur(gap)} avec la facture — type frais bancaires ou déduction (résolution en phase 2)`);
            return r;
          }
          // paiement partiel net : proposition avec résiduel
          const ratio = payment.amountCents / inv.amountCents;
          const evidence: Evidence[] = [
            { kind: 'reference_in_label', detail: `référence ${inv.number} lue dans le libellé` },
            { kind: 'partial_amount', detail: `reçu ${fmtEur(payment.amountCents)} sur une facture de ${fmtEur(inv.amountCents)}` },
            dateEvidence,
          ];
          const proposal: Proposal = {
            invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: gap,
            confidence: 0.9, evidence,
            explanation: `Paiement partiel sur la facture ${inv.number} (référence explicite) — reste à recevoir : ${fmtEur(gap)}.`,
          };
          const r = base('proposal', 'matched_partial');
          r.proposal = proposal;
          if (ratio < 0.1) r.notes.push('acompte très partiel — vérifier auprès du client');
          return r;
        }

        // paiement > facture
        const r = base('flag', 'amount_mismatch');
        r.notes.push(`montant reçu supérieur à la facture de ${fmtEur(-gap)} — couverture d'autres éléments possible (résolution en phase 2)`);
        return r;
      }

      // R4 — aucune référence : client + montant
      if (!customer) {
        const r = base('abstain', 'unmatched_no_candidate');
        r.notes.push('aucune référence ni client identifiable dans le libellé — pas de rapprochement approximatif sur les numéros');
        return r;
      }

      const own = openInvoices.filter((i) => norm(i.customer) === norm(customer));
      const exact = own.filter((i) => i.amountCents === payment.amountCents && i.currency === payment.currency);

      if (exact.length === 1) {
        const inv = exact[0];
        const dateGapDays = Math.round(dayDiff(payment.date, inv.dueDate));
        const proposal: Proposal = {
          invoiceId: inv.id, assignedAmountCents: payment.amountCents, residualCents: 0,
          confidence: 0.8,
          evidence: [
            { kind: 'customer_consistency', detail: `client du libellé = titulaire de la facture (${customer})` },
            { kind: 'amount_exact', detail: `montant reçu = montant de la facture (${fmtEur(payment.amountCents)})` },
            { kind: 'date_window', detail: `écart de ${dateGapDays} j avec l'échéance` },
          ],
          explanation: `Affectation sans référence (client ${customer} + montant exact) — confiance limitée, validation humaine obligatoire.`,
        };
        const r = base('proposal', 'matched_exact');
        r.proposal = proposal;
        r.notes.push("affectation sans référence — vérifier l'intitulé avec le client avant validation");
        return r;
      }

      if (exact.length >= 2) {
        const r = base('flag', 'ambiguous');
        r.candidates = exact
          .map((i) => ({ invoiceId: i.id, score: 1 / (1 + dayDiff(payment.date, i.dueDate)), reason: 'même client, même montant' }))
          .sort((a, b) => b.score - a.score);
        r.notes.push('plusieurs factures ouvertes de même montant pour ce client — le libellé ne permet pas de trancher');
        return r;
      }

      const r = base('abstain', 'unmatched_no_candidate');
      r.notes.push('client identifié mais aucun montant ne correspond — ventilation ou paiement partiel possible (résolution en phase 2)');
      return r;
    },
  };
}

export default { createEngine };
