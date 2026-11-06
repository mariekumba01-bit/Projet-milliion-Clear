// ─────────────────────────────────────────────────────────────────────────────
// ClearMatch Benchmark — Contrat partagé (moteur de référence, dataset, scorer)
// Toutes les valeurs monétaires sont des centimes entiers (jamais de flottants).
// ─────────────────────────────────────────────────────────────────────────────

export type Decision = 'proposal' | 'flag' | 'abstain';

/** Taxonomie v0.1 — 8 classes. Le moteur ne peut jamais prédire hors taxonomie. */
export const CLASSES = [
  'matched_exact',        // proposition : référence + montant exact
  'matched_partial',      // proposition : référence + paiement partiel, résiduel calculé
  'amount_mismatch',      // flag : référence trouvée, écart de montant (frais / déduction / trop-perçu)
  'currency_mismatch',    // flag : référence trouvée, devises différentes
  'rejected_or_reversal', // flag : transaction négative (rejet, annulation) — jamais proposée
  'ambiguous',            // flag/abstain : plusieurs candidats indiscernables ou contradiction
  'unmatched_no_candidate', // abstain : aucune affectation fiable possible
  'multi_reference_grouped', // flag : plusieurs références distinctes dans un même libellé (virement groupé)
] as const;
export type Classification = (typeof CLASSES)[number];

export interface Evidence { kind: string; detail: string }
export interface Candidate { invoiceId: string; score: number; reason: string }

export interface Proposal {
  invoiceId: string;
  assignedAmountCents: number; // centimes affectés à la facture (= montant du paiement en v0.1, pas de ventilation)
  residualCents: number;       // reste à recevoir sur la facture après affectation
  confidence: number;          // [0,1]
  evidence: Evidence[];        // ≥ 2 éléments exigés par le scorer
  explanation: string;         // phrase en français, jamais vide
}

export interface EngineResult {
  paymentId: string;
  requiresHuman: true;        // invariant absolu v0.1 : aucune écriture automatique
  decision: Decision;
  classification: Classification;
  proposal: Proposal | null;  // non-null si et seulement si decision === 'proposal'
  candidates: Candidate[];    // rempli pour 'ambiguous' : candidats classés, jamais affectés
  notes: string[];
  llmCalls: number;           // v0.1 déterministe : 0 par construction
}

export interface Invoice {
  id: string;
  number: string;              // ex. "FA2026-0142" (variante affichée "2026-0142")
  customer: string;            // raison sociale exacte du client
  customerReference: string | null; // référence commande client éventuelle
  amountCents: number;
  currency: 'EUR' | 'USD';
  issueDate: string;           // ISO
  dueDate: string;             // ISO
  open: boolean;               // false = déjà lettrée/fermée, hors périmètre
}

export interface Payment {
  id: string;
  label: string;               // libellé bancaire brut (bruit réel : NBSP, accents, casse)
  amountCents: number;         // négatif = rejet/annulation
  currency: 'EUR' | 'USD';
  date: string;
}

export interface EngineConfig {
  feeGapMaxCents: number;        // écart ≤ ce seuil (et paiement < facture) → flag frais/déduction
  deductionHintMaxRatio: number; // indice escompte/remise accepté jusqu'à ce ratio de la facture
  dateWindowDays: number;        // fenêtre de plausibilité de date (note, jamais filtre dur)
}

export interface Engine {
  process(payment: Payment, openInvoices: Invoice[], context: EngineContext): EngineResult;
}

export interface EngineContext {
  customers: string[];  // répertoire des clients connus (réaliste : fourni par le logiciel comptable)
  config: EngineConfig;
}

// ── Vérité terrain ────────────────────────────────────────────────────────────
export type Cohort = 'C1' | 'C2' | 'C3';

export interface ExpectedProposal {
  decision: 'proposal';
  classification: Classification;
  invoiceId: string;
  residualCents: number;
}

export interface ExpectedOther {
  decision: 'flag' | 'abstain';
  classification: Classification;
  noteContains?: string;
  candidatesInclude?: string[]; // pour 'ambiguous' : la bonne facture doit figurer parmi les candidats
}

export type Expected = ExpectedProposal | ExpectedOther;

export interface Case {
  id: string;
  cohort: Cohort;
  phase2?: string;   // libellé du verrou phase 2 (grouped / ventilation / déduction / doublon)
  locked?: boolean;   // true = la phase 2 doit résoudre ; v0.1 n'a pas le droit de proposer
  sharedCustomerWith?: string[]; // ids des cas partageant volontairement le même client
  payment: Payment;
  invoices: Invoice[];
  expected: Expected;
}
