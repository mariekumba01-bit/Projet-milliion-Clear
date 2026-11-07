'use strict';
// Abonnements ClearMatch — modèle « lien de paiement par mois » (l'API SasPay v1.0.0
// n'a pas de prélèvement récurrent natif) : lien FIXED créé/envoyé J1, rappelé J7,
// accès suspendu J21 si non réglé. Toutes les transitions sont scellées au journal
// d'audit. Sans SASPAY_API_KEY, les liens sont créés en mode « manual » (téléversement
// du lien réel par l'équipe, depuis le tableau de bord SasPay) — jamais simulés
// comme « payés ».
import { tierToFcfa, monthlyLinkPlan, createPaymentLink, parseWebhook, parseAmount, verifyWebhookSignature } from './integrations/saspay.js';
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
    "SELECT * FROM payment_links WHERE subscription_id = $1 AND period_month = $2 AND status = 'created'",
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
    saspayId: created.id ?? null, note: created.reason ?? null,
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
    plan, period, dueDate: sub.due_date, linkId: link.id, mode: link.mode,
  });
  return { subscription: sub, link };
}

/**
 * Webhook entrant : signature (temps constant) → idempotence (PK sur id d'événement)
 * → affectation du paiement au lien ouvert du montant correspondant. Une ambiguity
 * (0 ou ≥ 2 liens) n'est JAMAIS résolue par devinette : audit + arbitrage humain.
 */
export async function processSaspayWebhook(db, cfg, { rawBody, signatureHeader, timestampHeader }) {
  if (!cfg.saspay.webhookSecret) {
    throw new HttpError(503, 'webhook_not_configured', 'SASPAY_WEBHOOK_SECRET absent — webhooks refusés plutôt qu’acceptés sans vérification');
  }
  const sig = verifyWebhookSignature({ rawBody, timestampHeader, signatureHeader, secret: cfg.saspay.webhookSecret });
  const parsed = parseWebhook(rawBody);
  const data = parsed.ok ? parsed.value.data : {};
  const eventId = `${parsed.ok ? parsed.value.event : 'unknown'}:${data.id ?? sha256hex(rawBody).slice(0, 24)}`;

  const inserted = await db.query(
    `INSERT INTO saspay_events (id, event, payload, signature_ok)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    [eventId, parsed.ok ? parsed.value.event : `invalid:${parsed.reason}`, JSON.stringify({ data, raw: rawBody.slice(0, 8000) }), sig.ok],
  );
  if (!inserted.length) return { duplicate: true, eventId };

  if (!sig.ok) return { accepted: false, invalid: true, reason: sig.reason, eventId };
  if (!parsed.ok) return { accepted: false, invalid: true, reason: parsed.reason, eventId };

  const event = parsed.value.event;
  if (event !== 'transaction.success') {
    return { accepted: true, matched: false, reason: `événement ${event} sans action de facturation (archivé, idempotent)`, eventId };
  }

  const amountFcfa = data.amount != null ? parseAmount(String(data.amount)) : null;
  const candidates = amountFcfa == null ? [] : await db.query(
    `SELECT l.*, s.company_id
     FROM payment_links l JOIN subscriptions s ON s.id = l.subscription_id
     WHERE l.status = 'created' AND l.amount_fcfa = $1`,
    [amountFcfa],
  );
  if (candidates.length !== 1) {
    // 0 (montant inconnu) ou ≥2 (deux entreprises, même palier) : jamais de devinette.
    if (candidates.length > 0) {
      await appendAudit(db, candidates[0].company_id, 'billing.webhook_unmatched', {
        eventId, amountFcfa, candidates: candidates.length,
        note: 'arbitrage humain requis — réconciliation autoritaire par GET /payment-links/{id}/transactions/',
      });
    }
    return { accepted: true, matched: false, eventId, reason: candidates.length === 0
      ? 'aucun lien ouvert à ce montant — à réconcilier (GET /payment-links/{id}/transactions/)'
      : `${candidates.length} liens ouverts au même montant — arbitrage humain requis` };
  }
  const link = candidates[0];
  await db.query("UPDATE payment_links SET status = 'paid', paid_at = $2 WHERE id = $1 AND status = 'created'", [link.id, nowIso()]);
  await db.query(
    `UPDATE subscriptions SET status = 'active', period_month = $2, due_date = $3, updated_at = now()
     WHERE id = $1`,
    [link.subscription_id, link.period_month, dueDateFor(link.period_month)],
  );
  await appendAudit(db, link.company_id, 'billing.payment_received', {
    eventId, amountFcfa, period: link.period_month, saspayTransaction: data.reference ?? data.id ?? null,
    charged: data.charged ?? null, netAmount: data.net_amount ?? null,
  });
  return { accepted: true, matched: true, companyId: link.company_id, period: link.period_month, eventId };
}

/** Ordonnanceur J1/J7/J21 — appelable manuellement (admin) ou par cron externe. */
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
