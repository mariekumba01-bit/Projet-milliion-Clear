'use strict';
// Service moteur : tourne sur les données RÉELLES de l'entreprise (PostgreSQL),
// avec les seuils exacts du moteur de référence (feeGapMaxCents 800, déductions
// 0.15, fenêtre 45 j). La décision humaine (validate/reject) est finale et
// préservée lors des ré-analyses — le moteur ne re-traite jamais ce qu'un
// comptable a déjà arbitré.
import { v02 } from './core.js';
import demo from './demo-portfolio.json' with { type: 'json' };
import { appendAudit } from '../audit.js';
import { HttpError } from '../auth.js';
import { nowIso } from '../util.js';

export const DEMO_PORTFOLIO = demo;

function buildCtx(customers, cfg, batchPayments) {
  return {
    customers,
    config: {
      feeGapMaxCents: cfg.engine.feeGapMaxCents,
      deductionHintMaxRatio: cfg.engine.deductionHintMaxRatio,
      dateWindowDays: cfg.engine.dateWindowDays,
    },
    batchPayments,
  };
}

export async function loadPortfolio(db, companyId, cfg) {
  const invoices = await db.query(
    `SELECT external_id AS id, number, customer, customer_reference AS "customerReference",
            amount_cents AS "amountCents", currency, issue_date::text AS "issueDate",
            due_date::text AS "dueDate", open
     FROM invoices WHERE company_id = $1 AND open = true`,
    [companyId],
  );
  const payments = await db.query(
    `SELECT id, external_id AS id2, label, amount_cents AS "amountCents", currency, date::text AS date
     FROM payments WHERE company_id = $1 ORDER BY id`,
    [companyId],
  );
  const enginePayments = payments.map((p) => ({
    id: String(p.id),
    label: p.label,
    amountCents: p.amountCents,
    currency: p.currency,
    date: p.date,
  }));
  const customers = [...new Set(invoices.map((i) => i.customer))];
  return { invoices, payments: enginePayments, ctx: buildCtx(customers, cfg, enginePayments) };
}

/** Analyse le portefeuille stocké ; les décisions humaines existantes sont intouchables. */
export async function reanalyze(db, companyId, cfg) {
  const { invoices, payments, ctx } = await loadPortfolio(db, companyId, cfg);
  const decided = new Set(
    (await db.query(
      `SELECT payment_row_id FROM exceptions WHERE company_id = $1 AND status <> 'proposed'`,
      [companyId],
    )).map((r) => String(r.payment_row_id)),
  );
  const counts = { proposal: 0, flag: 0, abstain: 0, skippedDecided: 0 };
  await db.tx(async (q) => {
    for (const payment of payments) {
      if (decided.has(payment.id)) { counts.skippedDecided++; continue; }
      const result = v02(payment, invoices, ctx);
      counts[result.decision]++;
      await q('DELETE FROM exceptions WHERE company_id = $1 AND payment_row_id = $2 AND status = $3',
        [companyId, Number(payment.id), 'proposed']);
      await q(
        `INSERT INTO exceptions (company_id, payment_row_id, decision, classification, result)
         VALUES ($1, $2, $3, $4, $5)`,
        [companyId, Number(payment.id), result.decision, result.classification, JSON.stringify(result)],
      );
    }
  });
  await appendAudit(db, companyId, 'engine.reanalyze', { counts });
  return counts;
}

/** Analyse à la volée d'un libellé saisi (non stockée, scellée au journal d'audit). */
export async function analyzeLive(db, companyId, cfg, { label, amountEur, currency }) {
  const { invoices, payments, ctx } = await loadPortfolio(db, companyId, cfg);
  const amountCents = Math.round(Number(amountEur) * 100);
  if (!Number.isFinite(amountCents) || amountCents === 0) {
    throw new HttpError(400, 'invalid_amount', 'montant invalide — le moteur n’analyse jamais un montant vide');
  }
  const payment = {
    id: 'live', label: String(label || 'VIR SEPA'), amountCents,
    currency: currency === 'USD' ? 'USD' : 'EUR', date: new Date().toISOString().slice(0, 10),
  };
  const liveCtx = buildCtx(ctx.customers, cfg, [...payments, payment]);
  const result = v02(payment, invoices, liveCtx);
  await appendAudit(db, companyId, 'engine.analyze', {
    label: payment.label, amountCents, currency: payment.currency,
    decision: result.decision, classification: result.classification,
  });
  return result;
}

/** Décision humaine finale : génère l'écriture proposée (jamais postée) et scelle au journal. */
export async function decide(db, companyId, exceptionId, { decision, note }, userId, cfg) {
  const rows = await db.query(
    `SELECT e.*, p.label, p.amount_cents, p.currency
     FROM exceptions e JOIN payments p ON p.id = e.payment_row_id
     WHERE e.id = $1 AND e.company_id = $2`,
    [exceptionId, companyId],
  );
  const ex = rows[0];
  if (!ex) throw new HttpError(404, 'not_found', 'exception introuvable pour cette entreprise');
  if (ex.status !== 'proposed') {
    throw new HttpError(409, 'already_decided', `décision déjà prise (${ex.status}) — elle est finale`);
  }
  const decisionLc = String(decision || '').toLowerCase();
  if (!['accept', 'reject'].includes(decisionLc)) {
    throw new HttpError(400, 'invalid_decision', 'decision doit valoir accept ou reject');
  }
  const result = typeof ex.result === 'string' ? JSON.parse(ex.result) : ex.result;
  let entry = null;
  if (decisionLc === 'accept' && result.proposal) {
    const lines = [];
    const breakdown = result.proposal.breakdown;
    if (breakdown?.length) {
      for (const b of breakdown) {
        lines.push({ account: '411', label: `Client — ${b.invoiceNumber}`, debit: 0, credit: b.assignedCents });
      }
    } else {
      // l'invoiceId du moteur = external_id du portefeuille ('inv-…'), jamais la PK série ;
      // et toujours scopé à l'entreprise (isolation tenants)
      const info = await db.query(
        'SELECT number, customer FROM invoices WHERE company_id = $1 AND (external_id = $2 OR id::text = $2)',
        [companyId, String(result.proposal.invoiceId)],
      );
      const ref = info[0]?.number ?? `#${result.proposal.invoiceId}`;
      lines.push({ account: '411', label: `Client — ${ref}${info[0] ? ` (${info[0].customer})` : ''}`, debit: 0, credit: result.proposal.assignedAmountCents });
    }
    const total = ex.amount_cents;
    lines.push({ account: '512', label: 'Banque — encaissement', debit: total, credit: 0 });
    entry = { lines, note: 'écriture proposée — validation comptable requise avant tout report' };
    await db.query(
      'INSERT INTO journal_entries (company_id, exception_id, lines, note) VALUES ($1, $2, $3, $4)',
      [companyId, exceptionId, JSON.stringify(entry.lines), entry.note],
    );
  }
  await db.query(
    `UPDATE exceptions SET status = $3, decided_by = $4, decided_at = $5, decision_note = $6
     WHERE id = $1 AND company_id = $2`,
    [exceptionId, companyId, decisionLc === 'accept' ? 'validated' : 'rejected', userId, nowIso(), String(note || '')],
  );
  await appendAudit(db, companyId, 'exception.decided', {
    exceptionId, decision: decisionLc, by: userId, classification: ex.classification, entry,
  });
  return { status: decisionLc === 'accept' ? 'validated' : 'rejected', entry };
}

/** Import idempotent (source manual) — doublons (company, source, external_id) ignorés. */
export async function importInvoices(db, companyId, list, source = 'manual') {
  let kept = 0, skipped = 0;
  for (const inv of Array.isArray(list) ? list : []) {
    try {
      await db.query(
        `INSERT INTO invoices (company_id, source, external_id, number, customer, customer_reference, amount_cents, currency, issue_date, due_date, open)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
         ON CONFLICT (company_id, source, external_id) DO NOTHING`,
        [companyId, source, String(inv.id), String(inv.number), String(inv.customer), inv.customerReference ?? null,
         Number(inv.amountCents), inv.currency === 'USD' ? 'USD' : 'EUR', String(inv.issueDate), String(inv.dueDate)],
      );
      kept++;
    } catch { skipped++; }
  }
  await appendAudit(db, companyId, 'portfolio.import', { kind: 'invoices', source, kept, skipped });
  return { kept, skipped };
}

export async function importPayments(db, companyId, list, source = 'manual') {
  let kept = 0, skipped = 0;
  for (const p of Array.isArray(list) ? list : []) {
    try {
      await db.query(
        `INSERT INTO payments (company_id, source, external_id, label, amount_cents, currency, date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (company_id, source, external_id) DO NOTHING`,
        [companyId, source, String(p.id), String(p.label), Number(p.amountCents),
         p.currency === 'USD' ? 'USD' : 'EUR', String(p.date)],
      );
      kept++;
    } catch { skipped++; }
  }
  await appendAudit(db, companyId, 'portfolio.import', { kind: 'payments', source, kept, skipped });
  return { kept, skipped };
}

export async function seedDemo(db, companyId, cfg) {
  const inv = await importInvoices(db, companyId, DEMO_PORTFOLIO.invoices.map((i, k) => ({ ...i, id: i.id ?? `demo-inv-${k + 1}` })), 'demo');
  const pay = await importPayments(db, companyId, DEMO_PORTFOLIO.payments.map((p, k) => ({ ...p, id: p.id ?? `demo-pay-${k + 1}` })), 'demo');
  await appendAudit(db, companyId, 'portfolio.seed_demo', {
    invoices: inv.kept, payments: pay.kept,
    note: 'portefeuille de démonstration généré — aucune donnée réelle',
  });
  const counts = await reanalyze(db, companyId, cfg);
  return { inv, pay, counts };
}
