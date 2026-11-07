// ─────────────────────────────────────────────────────────────────────────────
// Vérité terrain phase 2 — attentes du moteur v0.2 sur la cohorte C3 (18 cas).
//
// Les attentes sont exprimées RELATIVEMENT au contenu du cas (factures du cas,
// montant du paiement) : aucun identifiant ni montant magique n'est codé en dur,
// la cohérence avec le dataset est vérifiable par simple lecture.
//
//   • les 17 cas verrouillés doivent être RÉSOLUS par v0.2 (proposition ventilée
//     ou alerte spécifique) là où v0.1 devait s'abstenir ;
//   • le témoin déverrouillé (case-110) doit passer de « partiel » (v0.1) à
//     « déduction reconnue » (v0.2) ;
//   • les doublons restent des alertes sans affectation : la phase 2 détecte,
//     elle ne devine jamais.
// ─────────────────────────────────────────────────────────────────────────────
import { getDataset } from './dataset.ts';
import type { Case, Classification, Expected } from './types.ts';

type Spec = (c: Case) => Expected;

const prop = (classification: Classification, invoiceId: string, residualCents: number): Expected =>
  ({ decision: 'proposal', classification, invoiceId, residualCents }) as Expected;
const alert = (noteContains: string, candidatesInclude: string[]): Expected =>
  ({ decision: 'flag', classification: 'ambiguous', noteContains, candidatesInclude }) as Expected;

// résiduel total d'une ventilation avec escompte 2 % : Σ round(facture × 2 %)
const dedResidual = (c: Case): number => c.invoices.reduce((a, i) => a + Math.round(i.amountCents * 0.02), 0);
// résiduel total d'une ventilation au prorata (taux lu dans le paiement) : Σ (facture − affecté)
const prorataResidual = (c: Case, rate: number): number =>
  c.invoices.reduce((a, i) => a + (i.amountCents - Math.round(i.amountCents * rate)), 0);
// résiduel d'un partiel : facture − reçu
const partialResidual = (c: Case): number => c.invoices[0].amountCents - c.payment.amountCents;

export const PHASE2_SPEC: Record<string, Spec> = {
  // ventilation groupée — somme exacte (case-097 → case-101)
  'case-097': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  'case-098': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  'case-099': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  'case-100': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  'case-101': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  // ventilation groupée — escompte 2 % sur le groupe (case-102, case-103)
  'case-102': (c) => prop('multi_reference_grouped', c.invoices[0].id, dedResidual(c)),
  'case-103': (c) => prop('multi_reference_grouped', c.invoices[0].id, dedResidual(c)),
  // ventilation groupée — prorata 60 % (case-104 : paiement = 60 % de la somme)
  'case-104': (c) => prop('multi_reference_grouped', c.invoices[0].id, prorataResidual(c, c.payment.amountCents / c.invoices.reduce((a, i) => a + i.amountCents, 0))),
  // ventilation libre — combinaison unique de 2 factures sur 3, sans référence (case-105)
  'case-105': (c) => prop('multi_reference_grouped', c.invoices[0].id, 0),
  // paiements partiels sans référence, acompte lu dans le libellé (case-106, case-107)
  'case-106': (c) => prop('matched_partial', c.invoices[0].id, partialResidual(c)),
  'case-107': (c) => prop('matched_partial', c.invoices[0].id, partialResidual(c)),
  // déductions justifiées — escompte/remise signalés (case-108, case-109)
  'case-108': (c) => prop('matched_exact', c.invoices[0].id, 0),
  'case-109': (c) => prop('matched_exact', c.invoices[0].id, 0),
  // témoin déverrouillé : v0.1 proposait un partiel, v0.2 reconnaît la déduction (case-110)
  'case-110': (c) => prop('matched_exact', c.invoices[0].id, 0),
  // doublons de facture confirmés — alerte, jamais d'affectation (case-111, case-112)
  'case-111': (c) => alert('doublon de facture confirmé', [c.invoices[0].id, c.invoices[1].id]),
  'case-112': (c) => alert('doublon de facture confirmé', [c.invoices[0].id, c.invoices[1].id]),
  // doublons de paiement probable — alerte, jamais d'affectation (case-113, case-114)
  'case-113': (c) => alert('doublon de paiement probable', [c.invoices[0].id, c.invoices[1].id]),
  'case-114': (c) => alert('doublon de paiement probable', [c.invoices[0].id, c.invoices[1].id]),
};

export interface Phase2Entry {
  caseId: string;
  label: string;      // libellé du verrou phase 2 (venant du dataset)
  locked: boolean;
  paymentId: string;
  expected: Expected; // attendu v0.2
}

/** Cohorte C3 complète, chaque cas assorti de son attendu v0.2 résolu. */
export function getPhase2Cases(): Phase2Entry[] {
  const ds = getDataset();
  return ds.cases
    .filter((c) => c.cohort === 'C3')
    .map((c) => {
      const spec = PHASE2_SPEC[c.id];
      if (!spec) throw new Error(`cas C3 sans spécification phase 2 : ${c.id}`);
      return { caseId: c.id, label: c.phase2 ?? '(C3 sans verrou)', locked: !!c.locked, paymentId: c.payment.id, expected: spec(c) };
    });
}

/** Couverture : chaque spécification correspond à un cas C3 existant — aucun fantôme. */
export function phase2CoverageOk(): { ok: boolean; missing: string[]; extra: string[] } {
  const ds = getDataset();
  const c3Ids = ds.cases.filter((c) => c.cohort === 'C3').map((c) => c.id);
  const specIds = Object.keys(PHASE2_SPEC);
  return {
    ok: c3Ids.length === specIds.length && c3Ids.every((id) => PHASE2_SPEC[id] != null) && specIds.every((id) => c3Ids.includes(id)),
    missing: c3Ids.filter((id) => PHASE2_SPEC[id] == null),
    extra: specIds.filter((id) => !c3Ids.includes(id)),
  };
}
