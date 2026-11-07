// ─────────────────────────────────────────────────────────────────────────────
// Connecteur SasPay v0.2.1 — couche de traduction PURE, sans réseau.
//
// SasPay (saspay.me) : API REST unique pour encaisser (mobile money, carte) en
// Afrique de l'Ouest et du Centre. Spécification de vérité :
// https://docs.saspay.me/api-reference/openapi.json (v1.0.0, relue le 7 nov. 2026).
// Règle éditrice : « n'inventez aucun endpoint, champ ou webhook absent de la
// spécification OpenAPI » — ce module n'appelle JAMAIS le réseau : il construit,
// valide et vérifie, à la manière du connecteur Pennylane. L'envoi réel (POST
// /payment-links/, webhooks entrants) est branché au jour J sans rien réécrire ici.
//
// Choix produit documenté : l'API v1.0.0 n'a PAS de prélèvement récurrent natif.
// La facturation mensuelle des abonnements suit donc le modèle « lien par mois » :
// un lien FIXED par palier et par mois, envoyé au client (courriel/WhatsApp),
// paiements suivis par transactions-issues-du-lien + webhooks. Le plan opérationnel
// est codé dans monthlyLinkPlan().
// ─────────────────────────────────────────────────────────────────────────────
import { createHmac } from 'node:crypto';

// ── Types SasPay (champs exacts de l'OpenAPI, rien d'inventé) ──────────────────

/** Corps de POST /payment-links/ — champs de la spécification v1.0.0. */
export interface SaspayLinkRequest {
  name: string;
  description?: string;
  amount_type: 'FIXED' | 'FREE';
  amount?: string;        // décimal en chaîne, ex. "25000.00" (FCFA)
  min_amount?: string;
  currency: string;       // ex. "XOF"
  is_active: boolean;
  usage_limit?: number;
  require_phone: boolean;
}

/** Événements webhooks — catalogue officiel (13 types), webhooks créés uniquement depuis le tableau de bord. */
export const SASPAY_EVENTS = [
  'transaction.created', 'transaction.success', 'transaction.failed', 'transaction.cancelled',
  'settlement.requested', 'settlement.approved', 'settlement.success', 'settlement.failed', 'settlement.cancelled',
  'wallet_transfer.requested', 'wallet_transfer.completed', 'wallet_transfer.rejected',
  'webhook.test',
] as const;
export type SaspayEvent = (typeof SASPAY_EVENTS)[number];
export const isSaspayEvent = (v: unknown): v is SaspayEvent =>
  typeof v === 'string' && (SASPAY_EVENTS as readonly string[]).includes(v);

/** Enveloppe webhook : { "event": "...", "data": { ... } } — format documenté. */
export interface SaspayWebhook {
  event: SaspayEvent;
  data: {
    id?: string;
    reference?: string;
    type?: string;
    status?: string;
    amount?: string;
    fee?: string;
    charged?: string;
    net_amount?: string;
    fee_charge_mode?: 'ADD_ON' | 'DEDUCTED';
    currency?: string;
    country?: string;
    network?: string;
    msisdn?: string;
    [k: string]: unknown;
  };
}

export type Check<T> = { ok: true; value: T } | { ok: false; reason: string };

// ── 1. Liens de paiement — validation croisée déléguée à l'intégrateur ────────
// « Aucune validation croisée n'est appliquée côté serveur entre amount_type et
//  amount : vérifiez la cohérence de ces deux champs côté intégrateur avant de
//  créer le lien. » (doc payment-links) — c'est le rôle exact de buildLinkRequest.

const AMOUNT_RE = /^\d+(\.\d{1,2})?$/; // décimal positif, 2 décimales max — format "25000.00"

export function buildLinkRequest(input: {
  name: string;
  currency: string;
  amountType: 'FIXED' | 'FREE';
  amount?: number;     // montant entier ou décimal, unité pleine (FCFA)
  minAmount?: number;
  description?: string;
  usageLimit?: number;
}): Check<SaspayLinkRequest> {
  if (!input.name.trim()) return { ok: false, reason: 'name vide' };
  if (!input.currency.trim()) return { ok: false, reason: 'currency vide' };
  if (input.amountType === 'FIXED') {
    if (input.amount == null) return { ok: false, reason: 'amount_type=FIXED sans amount — le lien ne saurait pas quoi facturer (aucune validation côté SasPay)' };
    if (!(input.amount > 0)) return { ok: false, reason: 'amount doit être > 0' };
    if (input.minAmount != null) return { ok: false, reason: 'min_amount n’a de sens qu’en FREE' };
  } else {
    if (input.amount != null) return { ok: false, reason: 'amount_type=FREE avec amount — contradictoire : le client choisit son montant' };
    if (input.minAmount != null && !(input.minAmount > 0)) return { ok: false, reason: 'min_amount doit être > 0' };
  }
  if (input.usageLimit != null && !(input.usageLimit >= 1)) return { ok: false, reason: 'usage_limit doit être ≥ 1' };
  const fmt = (n: number): string => (Number.isInteger(n) ? `${n}.00` : n.toFixed(2));
  return {
    ok: true,
    value: {
      name: input.name.trim(),
      ...(input.description ? { description: input.description } : {}),
      amount_type: input.amountType,
      ...(input.amountType === 'FIXED' ? { amount: fmt(input.amount!) } : {}),
      ...(input.amountType === 'FREE' && input.minAmount != null ? { min_amount: fmt(input.minAmount) } : {}),
      currency: input.currency.trim().toUpperCase(),
      is_active: true,
      ...(input.usageLimit != null ? { usage_limit: input.usageLimit } : {}),
      require_phone: true,
    },
  };
}

// ── 2. Webhooks entrants — signature + âge (deux contrôles, pas un seul) ──────
// Spécification vérifiée (doc webhooks) :
//   headers X-Webhook-Signature (hex sha256 HMAC, minuscules), X-Webhook-Timestamp
//   (Unix secondes), X-Webhook-Event ;
//   signed = `${timestamp}.${corps_brut}` — JAMAIS une re-sérialisation ;
//   tolérance d'âge : 5 minutes (300 s), l'horodatage étant scellé dans la signature.

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(args: {
  rawBody: string;
  timestampHeader: string;
  signatureHeader: string;
  secret: string;
  nowUnixSeconds?: number;
}): Check<true> {
  const ts = Number(args.timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'X-Webhook-Timestamp illisible' };
  const now = args.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: `âge rejeté : ${Math.abs(now - ts)} s d’écart (tolérance ${WEBHOOK_TOLERANCE_SECONDS} s) — sans ce contrôle, un webhook intercepté reste rejouable indéfiniment` };
  }
  const expected = createHmac('sha256', args.secret).update(`${ts}.${args.rawBody}`).digest('hex');
  if (expected !== args.signatureHeader.toLowerCase()) {
    return { ok: false, reason: 'signature invalide — recalculée sur le corps brut reçu, jamais sur une re-sérialisation' };
  }
  return { ok: true, value: true };
}

/** Parse l'enveloppe ; événement inconnu → refus explicite (jamais de guess, compat prospective assumée). */
export function parseWebhook(rawBody: string): Check<SaspayWebhook> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'corps JSON illisible' };
  }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'enveloppe absente' };
  const env = parsed as { event?: unknown; data?: unknown };
  if (!isSaspayEvent(env.event)) {
    return { ok: false, reason: `événement inconnu « ${String(env.event)} » — hors catalogue v1.0.0 ; ne rien déduire, journaliser et suivre la doc` };
  }
  if (!env.data || typeof env.data !== 'object') return { ok: false, reason: 'data absent' };
  return { ok: true, value: { event: env.event, data: env.data as SaspayWebhook['data'] } };
}

// ── 3. Montants — rapprocher sur charged et net_amount, jamais amount seul ────
// « Pour rapprocher votre comptabilité, utilisez charged (ce qui a quitté le compte
//  du client) et net_amount (ce qui vous revient) — jamais amount seul. » (doc)
//  ADD_ON    : le payeur débourse amount + fee ; vous recevez amount.
//  DEDUCTED  : le payeur débourse amount ; vous recevez amount − fee.

export function reconcileAmounts(t: {
  amount: number;
  fee: number;
  feeChargeMode: 'ADD_ON' | 'DEDUCTED';
}): { charged: number; netAmount: number } {
  return t.feeChargeMode === 'ADD_ON'
    ? { charged: t.amount + t.fee, netAmount: t.amount }
    : { charged: t.amount, netAmount: t.amount - t.fee };
}

/** Convertit une chaîne de montant SasPay ("25000.00") en nombre — sans flottant d'affichage. */
export function parseAmount(s: string): number {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`montant illisible : ${s}`);
  return Math.round(n * 100) / 100;
}

// ── 4. Paliers ClearMatch → FCFA ──────────────────────────────────────────────
// XOF comme XAF sont à parité fixe avec l'euro : 1 EUR = 655,957 FCFA (parité
// historique du franc CFA, identique pour les deux zones). Arrondi commercial au
// 500 FCFA le plus proche, pour un prix lisible en mobile money.

export const EUR_TO_FCFA = 655.957;

export function tierToFcfa(monthlyEur: number): { fcfa: number; rounded: number; peg: string } {
  if (!(monthlyEur > 0)) throw new Error('monthlyEur doit être > 0');
  const fcfa = monthlyEur * EUR_TO_FCFA;
  const rounded = Math.round(fcfa / 500) * 500;
  return { fcfa, rounded, peg: `1 EUR = ${EUR_TO_FCFA} FCFA (parité fixe), arrondi au 500 FCFA` };
}

// ── 5. Facturation mensuelle — le plan « lien par mois » ──────────────────────
// L'API v1.0.0 n'a pas de prélèvement récurrent natif. Chaque mois, pour chaque
// palier : un lien FIXED est créé (ou réutilisé), envoyé le jour 1, rappelé le
// jour 7, et l'accès est suspendu le jour 21 si non réglé. Les paiements remontent
// par GET /payment-links/{id}/transactions/ et les webhooks transaction.*.

export interface MonthlyLinkPlan {
  linkName: string;
  description: string;
  sendOnDay: 1;
  remindOnDay: 7;
  suspendOnDay: 21;
  amountType: 'FIXED';
  cadence: 'mensuelle';
}

export function monthlyLinkPlan(tier: { name: string; monthlyFcfa: number }, month: { year: number; month: number }): MonthlyLinkPlan {
  const mm = String(month.month).padStart(2, '0');
  const label = `${month.year}-${mm}`;
  // séparateur de milliers explicite (espace) : toLocaleString varie selon l'ICU (U+202F en fr-FR)
  const fcfa = String(tier.monthlyFcfa).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return {
    linkName: `ClearMatch ${tier.name} — ${label}`,
    description: `Abonnement ClearMatch ${tier.name} pour ${label} : ${fcfa} FCFA, payable en mobile money ou carte.`,
    sendOnDay: 1,
    remindOnDay: 7,
    suspendOnDay: 21,
    amountType: 'FIXED',
    cadence: 'mensuelle',
  };
}
