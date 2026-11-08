'use strict';
// Abonnements ClearMatch — modèle « lien de paiement par mois » (l'API SasPay v1.0.0
// n'a pas de prélèvement récurrent natif) : lien FIXED créé/envoyé J1, rappelé J7,
// accès suspendu J21 si non réglé. Toutes les transitions sont scellées au journal
// d'audit. Sans SASPAY_API_KEY, les liens sont créés en mode « manual » (créés depuis
// le tableau de bord SasPay) — jamais simulés comme « payés ».
//
// RÈGLES DE RÉCONCILIATION (revue sécurité/finance) :
//  1. La signature HMAC est vérifiée AVANT toute écriture en base : un webhook
//     frauduleux ne peut pas réserver un identifiant d'événement et bloquer ensuite
//     l'événement légitime (empoisonnement d'idempotence).
//  2. Un abonnement n'est JAMAIS activé sur la seule correspondance de montant :
//     l'activation exige la confirmation du prestataire (la transaction figure dans
//     les transactions du lien, via GET /payment-links/{id}/transactions/).
//  3. Sans clé API (mode manuel), un webhook cohérent place le lien en « candidate »
//     et demande un rapprochement HUMAIN (confirm-payment), scellé au journal.
//  4. Un identifiant de transaction ne peut payer qu'un seul lien (index unique).
import { tierToFcfa, monthlyLinkPlan, createPaymentLink, parseWebhook, parseAmount, verifyWebhookSignature, fetchLinkTransactions } from './integrations/saspay.js';
import { appendAudit } from './audit.js';
import { HttpError } from './auth.js';
import { sha256hex, nowIso } from './util.js';

export const PLANS = {
  starter: { name: 'Starter', monthlyEurCents: 4900, who: 'TPE / PME isolées sur Pennylane' },
  pro: { name: 'Pro', monthlyEurCents: 14900, who: 'PME à volumes soutenus' },
  cabinet: { name: 'Cabinet', monthlyEurCents: 39900, who: 'Cabinets comptables (le canal principal)' },
};

export const monthKey = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
/** Échéance de suspension = jour 21 du mois de période (plan documenté J1/J7/J21). */
export const dueDateFor = (mk) => `${mk}-21`;

export async function getSubscription(db, companyId) {
  const sub = (await db.query('SELECT * FROM subscriptions WHERE company_id = $1', [companyId]))[0] ?? null;
  if (!sub) return { status: 'none', plan: null, periodMonth: null, dueDate: null, links: [] };
  const links = await db.query(
    'SELECT * FROM payment_links WHERE subscription_id = $1 ORDER BY period_month DESC, id DESC',
    [sub.id],
  );
  return { ...sub, links };
}

async function ensureLink(db, cfg, sub, period, now = new Date()) {
  const existing = (await db.query(
    "SELECT * FROM payment_links WHERE subscription_id = $1 AND period_month = $2 AND status IN ('created', 'candidate')",
    [sub.id, period],
  ))[0];
  if (existing) return { link: existing, created: false };
  const plan = PLANS[sub.plan];
  const { rounded } = tierToFcfa(plan.monthlyEurCents / 100);
  const planInfo = monthlyLinkPlan(plan.name, rounded, { year: Number(period.slice(0, 4)), month: Number(period.slice(5, 7)) });
  const created = await createPaymentLink(cfg, {
    name: planInfo.linkName,
    description: planInfo.description,
    amountFcfa: rounded,
    usageLimit: 1,
  });
  const rows = await db.query(
    `INSERT INTO payment_links (company_id, subscription_id, period_month, amount_fcfa, mode, saspay_id, url, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'created') RETURNING *`,
    [sub.company_id, sub.id, period, rounded, created.mode, created.id ?? null, created.url ?? null],
  );
  await appendAudit(db, sub.company_id, 'billing.link_created', {
    period, plan: sub.plan, amountFcfa: rounded, mode: created.mode,
    saspayLinkId: created.id ?? null, note: created.reason ?? null,
  });
  return { link: rows[0], created: true };
}

/** Souscrire ou changer de palier : période courante si on est ≤ J21, sinon le mois suivant. */
export async function subscribe(db, cfg, companyId, plan, now = new Date()) {
  if (!PLANS[plan]) throw new HttpError(400, 'invalid_plan', `palier inconnu — ${Object.keys(PLANS).join(', ')}`);
  const day = now.getUTCDate();
  const period = day <= 21 ? monthKey(now) : monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)));
  const existing = (await db.query('SELECT * FROM subscriptions WHERE company_id = $1', [companyId]))[0];
  let sub;
  if (existing) {
    const rows = await db.query(
      `UPDATE subscriptions SET plan = $3, status = 'pending_payment', period_month = $4, due_date = $5, updated_at = now()
       WHERE company_id = $1 AND id = $2 RETURNING *`,
      [companyId, existing.id, plan, period, dueDateFor(period)],
    );
    sub = rows[0];
  } else {
    const rows = await db.query(
      `INSERT INTO subscriptions (company_id, plan, status, period_month, due_date)
       VALUES ($1, $2, 'pending_payment', $3, $4) RETURNING *`,
      [companyId, plan, period, dueDateFor(period)],
    );
    sub = rows[0];
  }
  const { link } = await ensureLink(db, cfg, sub, period, now);
  await appendAudit(db, companyId, 'subscription.updated', {
    plan, period, dueDate: sub.due_date, linkId: link.id, mode: link.mode, saspayLinkId: link.saspay_id,
  });
  return { subscription: sub, link };
}

// ── Webhooks SasPay ───────────────────────────────────────────────────────────

/** Traite un webhook : signature AVANT stockage, idempotence, puis réconciliation
 *  par identifiants fournisseur. Renvoie un verdict structuré, jamais d'effet de bord
 *  sur une information non vérifiée. */
export async function processSaspayWebhook(db, cfg, { rawBody, signatureHeader, timestampHeader }) {
  if (!cfg.saspay.webhookSecret) {
    throw new HttpError(503, 'webhook_not_configured', 'SASPAY_WEBHOOK_SECRET absent — webhooks refusés plutôt qu’acceptés sans vérification');
  }

  // 1) CRYPTOGRAPHIE D'ABORD : rien n'est écrit en base tant que la signature n'est pas prouvée.
  const sig = verifyWebhookSignature({ rawBody, timestampHeader, signatureHeader, secret: cfg.saspay.webhookSecret });
  if (!sig.ok) {
    console.warn(JSON.stringify({ level: 'security', msg: 'webhook signature refusée', reason: sig.reason, at: nowIso() }));
    return { accepted: false, invalid: true, reason: sig.reason, stored: false };
  }

  // 2) CORPS : enveloppe et catalogue d'événements — toujours avant tout stockage.
  const parsed = parseWebhook(rawBody);
  if (!parsed.ok) {
    console.warn(JSON.stringify({ level: 'security', msg: 'webhook malformé refusé', reason: parsed.reason, at: nowIso() }));
    return { accepted: false, invalid: true, reason: parsed.reason, stored: false };
  }

  const data = parsed.value.data;
  const event = parsed.value.event;
  const eventId = `${event}:${data.id ?? sha256hex(rawBody).slice(0, 24)}`;

  // 3) IDEMPOTENCE : l'événement prouvé est inscrit (PK) — un même id ne sera jamais traité deux fois.
  const inserted = await db.query(
    `INSERT INTO saspay_events (id, event, payload, signature_ok)
     VALUES ($1, $2, $3, true)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [eventId, event, JSON.stringify({ data, raw: rawBody.slice(0, 8000) })],
  );
  if (!inserted.length) return { duplicate: true, eventId, stored: true };

  if (event !== 'transaction.success') {
    return { accepted: true, matched: false, reason: `événement ${event} sans action de facturation (archivé, idempotent)`, eventId };
  }

  // 4) RÉCONCILIATION — jamais sur le seul montant : identifiants + devise + statut.
  const amountFcfa = data.amount != null ? parseAmount(String(data.amount)) : null;
  const currency = data.currency != null ? String(data.currency).toUpperCase() : null;
  const transactionId = data.id != null ? String(data.id) : null;
  const providerStatus = data.status != null ? String(data.status).toLowerCase() : null;
  if (providerStatus && !['success', 'successful', 'completed'].includes(providerStatus)) {
    return { accepted: true, matched: false, reason: `statut fournisseur « ${providerStatus} » sans activation`, eventId };
  }

  const candidates = amountFcfa == null ? [] : await db.query(
    `SELECT l.*, s.company_id
     FROM payment_links l JOIN subscriptions s ON s.id = l.subscription_id
     WHERE l.status IN ('created', 'candidate') AND l.amount_fcfa = $1`,
    [amountFcfa],
  );

  // antifraude : un identifiant de transaction déjà consommé ne peut rien payer d'autre
  if (transactionId) {
    const consumed = await db.query(
      'SELECT company_id FROM payment_links WHERE paid_transaction_ref = $1',
      [transactionId],
    );
    if (consumed.length) {
      await appendAudit(db, consumed[0].company_id, 'billing.transaction_replay', {
        transactionId, eventId, note: 'identifiant de transaction déjà consommé — aucune action',
      });
      return { accepted: true, matched: false, reason: 'transaction déjà consommée par un autre lien', eventId };
    }
  }

  // 4a) MODE FOURNISSEUR : vérification autoritaire via GET /payment-links/{id}/transactions/
  if (cfg.saspay.apiKey && candidates.length > 0) {
    for (const link of candidates) {
      try {
        const txs = await fetchLinkTransactions(cfg, link.saspay_id);
        const match = (Array.isArray(txs) ? txs : []).find((t) => String(t.id) === transactionId);
        if (!match) continue;
        const txStatus = String(match.status ?? 'success').toLowerCase();
        if (!['success', 'successful', 'completed'].includes(txStatus)) continue;
        return await confirmLinkPayment(db, link, {
          eventId, transactionId, amountFcfa, charged: data.charged ?? match.charged ?? null,
          netAmount: data.net_amount ?? match.net_amount ?? null, verifiedBy: 'provider_api',
        });
      } catch (e) {
        console.warn(JSON.stringify({ level: 'warn', msg: `vérification SasPay impossible pour le lien ${link.saspay_id} : ${e.message}` }));
      }
    }
    await appendAudit(db, candidates[0].company_id, 'billing.webhook_unmatched', {
      eventId, amountFcfa, transactionId, candidates: candidates.length,
      note: 'transaction introuvable dans les transactions des liens candidats — réconciliation manuelle',
    });
    return { accepted: true, matched: false, eventId, reason: 'transaction non confirmée par le prestataire — rapprochement manuel' };
  }

  // 4b) MODE MANUEL (pas de clé API) : cohérence montant/devise → « candidate » + arbitrage HUMAIN.
  //     Jamais d'activation automatique sans confirmation fournisseur.
  if (candidates.length === 1) {
    const link = candidates[0];
    if (currency && currency !== 'XOF') {
      return { accepted: true, matched: false, eventId, reason: `devise ${currency} incompatible avec le lien (XOF attendu)` };
    }
    await db.query("UPDATE payment_links SET status = 'candidate' WHERE id = $1 AND status = 'created'", [link.id]);
    await appendAudit(db, link.company_id, 'billing.manual_reconciliation_required', {
      eventId, transactionId, amountFcfa, linkId: link.id, period: link.period_month,
      note: 'paiement cohérent par montant/devise — activation soumise à confirmation humaine (vérification fournisseur impossible sans clé API)',
    });
    return { accepted: true, matched: false, manual: true, eventId, reason: 'rapprochement humain requis (mode manuel)' };
  }
  if (candidates.length > 1) {
    await appendAudit(db, candidates[0].company_id, 'billing.webhook_unmatched', {
      eventId, amountFcfa, transactionId, candidates: candidates.length,
      note: 'plusieurs liens au même montant — arbitrage humain requis',
    });
  }
  return { accepted: true, matched: false, eventId, reason: candidates.length === 0
    ? 'aucun lien ouvert à ce montant — à réconcilier'
    : `${candidates.length} liens ouverts au même montant — arbitrage humain requis` };
}

/** Activation autorisée : lien payé (identifiant de transaction consommé, index unique),
 *  abonnement actif sur la période du lien, tout scellé au journal. */
export async function confirmLinkPayment(db, link, { eventId, transactionId, amountFcfa, charged, netAmount, verifiedBy }) {
  const updated = await db.query(
    `UPDATE payment_links SET status = 'paid', paid_at = $2, paid_transaction_ref = $3
     WHERE id = $1 AND status IN ('created', 'candidate') AND paid_transaction_ref IS NULL
     RETURNING id`,
    [link.id, nowIso(), transactionId],
  );
  if (!updated.length) return { accepted: true, matched: false, reason: 'lien déjà réglé (course inter-événements protégée)', eventId };
  await db.query(
    `UPDATE subscriptions SET status = 'active', period_month = $2, due_date = $3, updated_at = now() WHERE id = $1`,
    [link.subscription_id, link.period_month, dueDateFor(link.period_month)],
  );
  await appendAudit(db, link.company_id, 'billing.payment_verified', {
    eventId, transactionId, saspayLinkId: link.saspay_id, linkRow: link.id,
    amountFcfa, period: link.period_month, charged, netAmount, verifiedBy,
  });
  return { accepted: true, matched: true, companyId: link.company_id, period: link.period_month, eventId };
}

/** Rapprochement HUMAIN (mode manuel) : un propriétaire/comptable confirme le paiement
 *  d'un lien « candidate » avec la référence de transaction et une note motivée. */
export async function confirmManualPayment(db, cfg, companyId, userId, { linkId, transactionRef, note }) {
  const link = (await db.query(
    `SELECT l.* FROM payment_links l JOIN subscriptions s ON s.id = l.subscription_id
     WHERE l.id = $1 AND l.company_id = $2 AND l.mode = 'manual' AND l.status = 'candidate'`,
    [linkId, companyId],
  ))[0];
  if (!link) throw new HttpError(404, 'no_candidate_link', 'aucun lien en rapprochement manuel pour cette entreprise avec cet identifiant');
  if (!transactionRef || !String(transactionRef).trim()) {
    throw new HttpError(400, 'missing_ref', 'référence de transaction SasPay requise pour le rapprochement');
  }
  const res = await confirmLinkPayment(db, link, {
    eventId: `manual:${sha256hex(String(transactionRef)).slice(0, 24)}`,
    transactionId: String(transactionRef).trim(),
    amountFcfa: link.amount_fcfa, charged: null, netAmount: null,
    verifiedBy: `human:${userId}`,
  });
  if (!res.matched) throw new HttpError(409, 'already_paid', 'lien déjà réglé');
  await appendAudit(db, companyId, 'billing.manual_confirmed', {
    linkId, transactionRef: String(transactionRef).trim(), by: userId, note: String(note || ''),
  });
  return res;
}

// ── Ordonnanceur J1/J7/J21 — appelable manuellement (admin) ou par cron externe ──
export async function schedulerTick(db, cfg, now = new Date()) {
  const subs = await db.query(
    "SELECT * FROM subscriptions WHERE status IN ('pending_payment', 'active', 'past_due')",
  );
  const actions = [];
  const period = monthKey(now);
  const day = now.getUTCDate();
  const due = new Date(`${dueDateFor(period)}T00:00:00Z`).getTime();

  for (const sub of subs) {
    const paidRow = (await db.query(
      "SELECT 1 FROM payment_links WHERE subscription_id = $1 AND period_month = $2 AND status = 'paid'",
      [sub.id, period],
    ))[0];
    const unpaid = !paidRow;

    if (unpaid) {
      const { link, created } = await ensureLink(db, cfg, sub, period, now);
      if (created) actions.push({ companyId: sub.company_id, action: 'link_created', period, mode: link.mode });

      if (day >= 7 && !link.reminder_sent_at && link.period_month === period) {
        await db.query('UPDATE payment_links SET reminder_sent_at = $2 WHERE id = $1', [link.id, nowIso()]);
        await appendAudit(db, sub.company_id, 'billing.reminder', {
          period, plan: sub.plan, channel: 'email/WhatsApp — envoi à intégrer (file d’envoi dédiée)',
        });
        actions.push({ companyId: sub.company_id, action: 'reminder', period });
      }
      if (now.getTime() >= due) {
        // active ou past_due : passé J21 sans paiement de la période courante → suspension
        await db.query("UPDATE subscriptions SET status = 'suspended', updated_at = now() WHERE id = $1", [sub.id]);
        await appendAudit(db, sub.company_id, 'billing.suspended', { period, reason: 'échéance J21 dépassée sans paiement' });
        actions.push({ companyId: sub.company_id, action: 'suspended', period });
      } else if (sub.status === 'active') {
        await db.query("UPDATE subscriptions SET status = 'past_due', updated_at = now() WHERE id = $1", [sub.id]);
        actions.push({ companyId: sub.company_id, action: 'past_due', period });
      }
    } else if (sub.status !== 'active') {
      await db.query("UPDATE subscriptions SET status = 'active', updated_at = now() WHERE id = $1", [sub.id]);
      await appendAudit(db, sub.company_id, 'billing.reactivated', { period });
      actions.push({ companyId: sub.company_id, action: 'reactivated', period });
    }
  }
  return { actions, checked: subs.length, at: now.toISOString() };
}

/** Contrôle d'accès moteur : bloqué uniquement si suspendu (désactivable en dev). */
export async function assertNotSuspended(db, cfg, companyId) {
  if (!cfg.billingEnforce) return;
  const sub = (await db.query('SELECT status FROM subscriptions WHERE company_id = $1', [companyId]))[0];
  if (sub?.status === 'suspended') {
    throw new HttpError(402, 'subscription_suspended', 'abonnement suspendu (J21 dépassé) — régler le lien du mois pour réactiver');
  }
}
