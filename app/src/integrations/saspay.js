'use strict';
// Intégration SasPay — port fidèle de src/connector-saspay.ts (spécification
// docs.saspay.me OpenAPI v1.0.0, relue le 7 nov. 2026) avec DEUX durcissements
// demandés en revue produit :
//   1. comparaison de signature À TEMPS CONSTANT (timingSafeEqual, jamais ===) ;
//   2. idempotence des webhooks garantie côté application (PK sur id d'événement).
// L'envoi réel (POST /payment-links/) est ici implémenté ; sans SASPAY_API_KEY,
// les liens restent en mode « manual » (créés depuis le tableau de bord SasPay).
import { hmacHex, constantTimeEquals } from '../util.js';

// ── Catalogue officiel des événements webhook (13 types, rien d'inventé) ──────
export const SASPAY_EVENTS = [
  'transaction.created', 'transaction.success', 'transaction.failed', 'transaction.cancelled',
  'settlement.requested', 'settlement.approved', 'settlement.success', 'settlement.failed', 'settlement.cancelled',
  'wallet_transfer.requested', 'wallet_transfer.completed', 'wallet_transfer.rejected',
  'webhook.test',
];

export const WEBHOOK_TOLERANCE_SECONDS = 300;

export function isSaspayEvent(v) {
  return typeof v === 'string' && SASPAY_EVENTS.includes(v);
}

/** Corps de POST /payment-links/ — validation croisée amount_type/amount (aucune côté SasPay). */
export function buildLinkRequest(input) {
  const AMOUNT_RE = /^\d+(\.\d{1,2})?$/;
  if (!input.name?.trim()) throw new Error('name vide');
  if (!input.currency?.trim()) throw new Error('currency vide');
  if (input.amountType === 'FIXED') {
    if (input.amount == null) throw new Error('amount_type=FIXED sans amount — le lien ne saurait pas quoi facturer');
    if (!(input.amount > 0)) throw new Error('amount doit être > 0');
    if (input.minAmount != null) throw new Error('min_amount n’a de sens qu’en FREE');
  } else if (input.amountType === 'FREE') {
    if (input.amount != null) throw new Error('amount_type=FREE avec amount — contradictoire');
    if (input.minAmount != null && !(input.minAmount > 0)) throw new Error('min_amount doit être > 0');
  } else {
    throw new Error('amountType doit valoir FIXED ou FREE');
  }
  if (input.usageLimit != null && !(input.usageLimit >= 1)) throw new Error('usage_limit doit être ≥ 1');
  const fmt = (n) => (Number.isInteger(n) ? `${n}.00` : n.toFixed(2));
  const req = {
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    amount_type: input.amountType,
    ...(input.amountType === 'FIXED' ? { amount: fmt(input.amount) } : {}),
    ...(input.amountType === 'FREE' && input.minAmount != null ? { min_amount: fmt(input.minAmount) } : {}),
    currency: input.currency.trim().toUpperCase(),
    is_active: true,
    ...(input.usageLimit != null ? { usage_limit: input.usageLimit } : {}),
    require_phone: true,
  };
  for (const [k, v] of Object.entries(req)) {
    if (['amount', 'min_amount'].includes(k) && !AMOUNT_RE.test(String(v))) {
      throw new Error(`format de montant invalide pour ${k} : ${v} (attendu "25000.00")`);
    }
  }
  return req;
}

/**
 * Vérification du webhook : âge (tolérance 300 s, horodatage scellé dans la signature)
 * PUIS HMAC hex sur `${timestamp}.${corps_brut}` comparé à temps constant.
 * Jamais de re-sérialisation du corps — la signature porte le bytes reçus.
 */
export function verifyWebhookSignature({ rawBody, timestampHeader, signatureHeader, secret, nowUnixSeconds }) {
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'X-Webhook-Timestamp illisible' };
  const now = nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return { ok: false, reason: `âge rejeté : ${Math.abs(now - ts)} s d’écart (tolérance ${WEBHOOK_TOLERANCE_SECONDS} s)` };
  }
  const expected = hmacHex(secret, `${ts}.${rawBody}`);
  if (!constantTimeEquals(expected, String(signatureHeader || '').toLowerCase())) {
    return { ok: false, reason: 'signature invalide — comparée à temps constant sur le corps brut reçu' };
  }
  return { ok: true, value: true };
}

/** Parse l'enveloppe { event, data } ; événement inconnu → refus explicite (compat prospective assumée). */
export function parseWebhook(rawBody) {
  let parsed;
  try { parsed = JSON.parse(rawBody); } catch { return { ok: false, reason: 'corps JSON illisible' }; }
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'enveloppe absente' };
  if (!isSaspayEvent(parsed.event)) {
    return { ok: false, reason: `événement inconnu « ${String(parsed.event)} » — hors catalogue v1.0.0 ; journaliser, ne rien déduire` };
  }
  if (!parsed.data || typeof parsed.data !== 'object') return { ok: false, reason: 'data absent' };
  return { ok: true, value: { event: parsed.event, data: parsed.data } };
}

/** Rapprochement : toujours sur charged et net_amount, jamais amount seul (ADD_ON vs DEDUCTED). */
export function reconcileAmounts({ amount, fee, feeChargeMode }) {
  return feeChargeMode === 'ADD_ON'
    ? { charged: amount + fee, netAmount: amount }
    : { charged: amount, netAmount: amount - fee };
}

/** "25000.00" → 25000 (FCFA), sans accumulation de flottant d'affichage. */
export function parseAmount(s) {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) throw new Error(`montant illisible : ${s}`);
  return Math.round(n * 100) / 100;
}

// ── Paliers → FCFA (parité fixe 1 EUR = 655,957, arrondi au 500) ──────────────
export const EUR_TO_FCFA = 655.957;

export function tierToFcfa(monthlyEur) {
  if (!(monthlyEur > 0)) throw new Error('monthlyEur doit être > 0');
  const fcfa = monthlyEur * EUR_TO_FCFA;
  return { fcfa, rounded: Math.round(fcfa / 500) * 500 };
}

/** Plan « lien par mois » : envoyé J1, rappelé J7, suspension J21 (port de monthlyLinkPlan). */
export function monthlyLinkPlan(tierName, monthlyFcfa, { year, month }) {
  const mm = String(month).padStart(2, '0');
  const fcfa = String(monthlyFcfa).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return {
    linkName: `ClearMatch ${tierName} — ${year}-${mm}`,
    description: `Abonnement ClearMatch ${tierName} pour ${year}-${mm} : ${fcfa} FCFA, payable en mobile money ou carte.`,
    sendOnDay: 1, remindOnDay: 7, suspendOnDay: 21, amountType: 'FIXED', cadence: 'mensuelle',
  };
}

// ── Client réseau réel (activé si SASPAY_API_KEY) ─────────────────────────────
export async function createPaymentLink(cfg, { name, description, amountFcfa, usageLimit }) {
  if (!cfg.saspay.apiKey) {
    return { mode: 'manual', reason: 'SASPAY_API_KEY absente — lien à créer depuis le tableau de bord SasPay' };
  }
  const body = buildLinkRequest({
    name, description, amountType: 'FIXED', amount: amountFcfa,
    currency: 'XOF', usageLimit,
  });
  const res = await fetch(`${cfg.saspay.baseUrl.replace(/\/$/, '')}/payment-links/`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.saspay.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`SasPay /payment-links/ → HTTP ${res.status} : ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json();
  // Champs attendus d'après la spécification ; défensif sur les variantes de nommage.
  const id = data.id ?? data.uuid ?? data.reference;
  const url = data.url ?? data.payment_url ?? data.checkout_url;
  if (!id) throw new Error(`réponse SasPay sans identifiant de lien : ${JSON.stringify(data).slice(0, 300)}`);
  return { mode: 'saspay', id: String(id), url: url ? String(url) : null };
}

/** Réconciliation autoritaire : GET /payment-links/{id}/transactions/ (documenté v1.0.0). */
export async function fetchLinkTransactions(cfg, saspayLinkId) {
  if (!cfg.saspay.apiKey || !saspayLinkId) return [];
  const res = await fetch(
    `${cfg.saspay.baseUrl.replace(/\/$/, '')}/payment-links/${encodeURIComponent(saspayLinkId)}/transactions/`,
    { headers: { Authorization: `Bearer ${cfg.saspay.apiKey}` } },
  );
  if (!res.ok) throw new Error(`SasPay transactions → HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.results ?? data.items ?? []);
}
