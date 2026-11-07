// ─────────────────────────────────────────────────────────────────────────────
// Tests du connecteur SasPay (src/connector-saspay.ts) — pur, sans réseau.
// Chaque règle testée provient de la documentation vérifiée (docs.saspay.me,
// OpenAPI v1.0.0, relus le 7 nov. 2026) ; les exemples numériques sont ceux de la
// doc officielle (ex. transaction 25 000 FCFA, frais 625).
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildLinkRequest, monthlyLinkPlan, parseAmount, parseWebhook,
  reconcileAmounts, SASPAY_EVENTS, tierToFcfa, verifyWebhookSignature,
} from '../src/connector-saspay.ts';

const SECRET = 'whsec_test_0000000000000000000000000000';
const sign = (body: string, ts: number, secret: string = SECRET): string =>
  createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

// ── Liens de paiement ─────────────────────────────────────────────────────────
test('saspay : lien FIXED valide — corps conforme, montant formaté "32000.00", require_phone', () => {
  const r = buildLinkRequest({ name: 'ClearMatch Starter — 2026-12', currency: 'XOF', amountType: 'FIXED', amount: 32000 });
  assert.ok(r.ok);
  assert.equal(r.value.amount_type, 'FIXED');
  assert.equal(r.value.amount, '32000.00');
  assert.equal(r.value.currency, 'XOF');
  assert.equal(r.value.is_active, true);
  assert.equal(r.value.require_phone, true);
  assert.ok(AMOUNT_OK(r.value.amount!));
});

test('saspay : la règle déléguée à l\'intégrateur — FIXED sans amount rejeté, FREE avec amount rejeté', () => {
  const a = buildLinkRequest({ name: 'x', currency: 'XOF', amountType: 'FIXED' });
  assert.equal(a.ok, false);
  assert.match(a.reason, /FIXED sans amount/);
  const b = buildLinkRequest({ name: 'x', currency: 'XOF', amountType: 'FREE', amount: 5000 });
  assert.equal(b.ok, false);
  assert.match(b.reason, /FREE avec amount/);
  const c = buildLinkRequest({ name: 'x', currency: 'XOF', amountType: 'FREE', minAmount: 1000 });
  assert.ok(c.ok);
  assert.equal(c.value.min_amount, '1000.00');
  assert.equal(c.value.amount, undefined);
});

test('saspay : FREE minAmount ≤ 0 et usage_limit < 1 rejetés ; décimal formaté à 2 chiffres', () => {
  const a = buildLinkRequest({ name: 'x', currency: 'xof', amountType: 'FREE', minAmount: 0 });
  assert.equal(a.ok, false);
  const b = buildLinkRequest({ name: 'x', currency: 'XOF', amountType: 'FIXED', amount: 1000, usageLimit: 0 });
  assert.equal(b.ok, false);
  const c = buildLinkRequest({ name: 'x', currency: 'XOF', amountType: 'FIXED', amount: 97500.5 });
  assert.ok(c.ok);
  assert.equal(c.value.amount, '97500.50');
});

// ── Webhooks : signature + âge ────────────────────────────────────────────────
test('saspay : signature valide acceptée (algorithme officiel : hmac sha256 de `${ts}.${corps brut}`)', () => {
  const body = JSON.stringify({ event: 'transaction.success', data: { id: '7c1a', reference: 'TXN-2026-000456', amount: '25000.00', fee: '625.00', fee_charge_mode: 'ADD_ON' } });
  const ts = 1_800_000_000;
  const r = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts), signatureHeader: sign(body, ts), secret: SECRET, nowUnixSeconds: ts + 60 });
  assert.ok(r.ok);
});

test('saspay : âge > 5 min rejeté — un webhook intercepté ne doit pas rester rejouable indéfiniment', () => {
  const body = '{"event":"webhook.test","data":{}}';
  const ts = 1_800_000_000;
  const r = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts), signatureHeader: sign(body, ts), secret: SECRET, nowUnixSeconds: ts + 301 });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /âge rejeté/);
});

test('saspay : corps modifié après signature — rejeté (la signature couvre le corps brut, pas une re-sérialisation)', () => {
  const body = '{"event":"transaction.success","data":{"amount":"25000.00"}}';
  const tampered = '{"event":"transaction.success","data":{"amount":"99000.00"}}'; // mêmes clés, valeur changée
  const ts = 1_800_000_000;
  const r = verifyWebhookSignature({ rawBody: tampered, timestampHeader: String(ts), signatureHeader: sign(body, ts), secret: SECRET, nowUnixSeconds: ts });
  assert.equal(r.ok, false);
  assert.match(r.reason!, /signature invalide/);
  // re-sérialisation identique au bit près : acceptée (l'ordre des clés et le formatage comptent)
  const r2 = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts), signatureHeader: sign(body, ts), secret: SECRET, nowUnixSeconds: ts });
  assert.ok(r2.ok);
});

test('saspay : horodatage rajeuni par un attaquant — signature ne correspond plus', () => {
  const body = '{"event":"webhook.test","data":{}}';
  const ts = 1_800_000_000;
  const later = 1_800_000_600; // attaquant décale now de +10 min mais garde ts jeune… non : il rajeunit ts
  const r = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts), signatureHeader: sign(body, ts), secret: SECRET, nowUnixSeconds: later });
  assert.equal(r.ok, false); // l'âge dépasse 300 s : rejeté. Et s'il falsifiait le header, la signature casserait (test précédent).
  const forged = sign(body, ts + 500); // signature calculée sur un autre ts
  const r2 = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts + 500), signatureHeader: forged, secret: SECRET, nowUnixSeconds: ts + 500 });
  assert.ok(r2.ok); // cohérent : ts+500 est dans la fenêtre par rapport à now
  const r3 = verifyWebhookSignature({ rawBody: body, timestampHeader: String(ts), signatureHeader: forged, secret: SECRET, nowUnixSeconds: ts + 100 });
  assert.equal(r3.ok, false); // la vraie contrainte : signature ET âge sur le MÊME header
});

// ── Enveloppe ─────────────────────────────────────────────────────────────────
test('saspay : parseWebhook — enveloppe conforme lue, événement hors catalogue refusé sans guess', () => {
  const ok = parseWebhook('{"event":"transaction.success","data":{"reference":"TXN-2026-000456","charged":"25625.00"}}');
  assert.ok(ok.ok);
  assert.equal(ok.value.event, 'transaction.success');
  assert.equal(ok.value.data.reference, 'TXN-2026-000456');
  const unknown = parseWebhook('{"event":"subscription.renewed","data":{}}');
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason!, /hors catalogue/);
  const bad = parseWebhook('pas json');
  assert.equal(bad.ok, false);
});

test('saspay : catalogue — 13 événements, dont les 4 transaction.* qui alimentent le suivi', () => {
  assert.equal(SASPAY_EVENTS.length, 13);
  for (const e of ['transaction.created', 'transaction.success', 'transaction.failed', 'transaction.cancelled']) {
    assert.ok((SASPAY_EVENTS as readonly string[]).includes(e));
  }
});

// ── Montants (exemple officiel : 25 000 FCFA, frais 625) ─────────────────────
test('saspay : reconcileAmounts — ADD_ON et DEDUCTED selon la doc, jamais amount seul', () => {
  const addon = reconcileAmounts({ amount: 25000, fee: 625, feeChargeMode: 'ADD_ON' });
  assert.deepEqual(addon, { charged: 25625, netAmount: 25000 });
  const deducted = reconcileAmounts({ amount: 25000, fee: 625, feeChargeMode: 'DEDUCTED' });
  assert.deepEqual(deducted, { charged: 25000, netAmount: 24375 });
  assert.equal(parseAmount('25000.00'), 25000);
  assert.throws(() => parseAmount('nonsense'), /montant illisible/);
});

// ── Paliers → FCFA ────────────────────────────────────────────────────────────
test('saspay : conversion des paliers — 49/149/399 € → 32 000 / 97 500 / 261 500 FCFA (parité 655,957, arrondi 500)', () => {
  assert.equal(tierToFcfa(49).rounded, 32000);    // 49 × 655,957 = 32 141,89 → 32 000
  assert.equal(tierToFcfa(149).rounded, 97500);   // 149 × 655,957 = 97 737,59 → 97 500
  assert.equal(tierToFcfa(399).rounded, 261500);  // 399 × 655,957 = 261 726,84 → 261 500
  // valeur exacte conservée pour audit : 32 141,89 (produit au pair, sans arrondi)
  assert.ok(Math.abs(tierToFcfa(49).fcfa - 49 * 655.957) < 1e-6);
});

// ── Plan mensuel ──────────────────────────────────────────────────────────────
test('saspay : monthlyLinkPlan — lien par mois (pas de récurrent natif), J1/J7/J21', () => {
  const p = monthlyLinkPlan({ name: 'Starter', monthlyFcfa: 32000 }, { year: 2026, month: 12 });
  assert.equal(p.linkName, 'ClearMatch Starter — 2026-12');
  assert.match(p.description, /32 000 FCFA/);
  assert.deepEqual([p.sendOnDay, p.remindOnDay, p.suspendOnDay], [1, 7, 21]);
  assert.equal(p.amountType, 'FIXED');
  assert.equal(p.cadence, 'mensuelle');
});

// helper local (évite l'import privé) : format décimal SasPay
function AMOUNT_OK(s: string): boolean { return /^\d+\.\d{2}$/.test(s) && Number(s) > 0; }
