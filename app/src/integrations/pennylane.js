'use strict';
// Intégration Pennylane réelle — OAuth2 authorization code + API externe v2.
// Toutes les URLs/champs sont ceux de la documentation officielle (pennylane.readme.io,
// relue le 7 nov. 2026) : oauth-20-walkthrough, v2-scopes, getcustomerinvoices, gettransactions.
//
// Points de conformité implémentés :
//  • client_id/client_secret en corps de requête (form-encoded), pas en Basic ;
//  • code d'autorisation à usage unique (5 min) — jamais réessayé ;
//  • ROTATION STRICTE du refresh token : le nouveau refresh persiste, l'ancien est invalide ;
//  • invalid_grant au refresh = terminale : la connexion repasse « reauthorized » ;
//  • montants v2 = chaînes en euros (amount) + currency_amount dans la devise de la facture
//    → conversion en centimes entiers, jamais de flottant accumulé ;
//  • devises supportées par le moteur : EUR/USD uniquement — XOF/XAF écartés avec
//    avertissement (jamais de conversion implicite) ;
//  • 429 → attente Retry-After (3 essais max) ; 401 → un seul refresh puis relance.
import { decryptSecret, encryptSecret, nowIso } from '../util.js';
import { appendAudit } from '../audit.js';
import { HttpError } from '../auth.js';

/** Les erreurs Pennylane sont des HttpError : 401/403/404/503 traversent le serveur tels quels. */
export class PennylaneError extends HttpError {
  constructor(status, code, message) {
    super(status, code, message);
    this.name = 'PennylaneError';
  }
}

export function requireConfigured(cfg) {
  if (!cfg.pennylane.clientId || !cfg.pennylane.clientSecret) {
    throw new PennylaneError(503, 'pennylane_not_configured',
      'PENNYLANE_CLIENT_ID/PENNYLANE_CLIENT_SECRET absents — le parcours OAuth partenaire Pennylane est prêt mais requiert les identifiants de l’app (partnerships@pennylane.com)');
  }
}

export function authorizeUrl(cfg, { redirectUri, state }) {
  requireConfigured(cfg);
  const u = new URL(cfg.pennylane.authUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', cfg.pennylane.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', cfg.pennylane.scopes);
  u.searchParams.set('state', state);
  return u.toString();
}

async function tokenPost(cfg, params) {
  const res = await fetch(cfg.pennylane.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: cfg.pennylane.clientId, client_secret: cfg.pennylane.clientSecret, ...params }),
  });
  const body = await res.text();
  let json = {};
  try { json = JSON.parse(body); } catch { /* réponse non JSON → erreur ci-dessous */ }
  if (!res.ok) {
    throw new PennylaneError(res.status, json.error || 'token_error',
      `Pennylane token endpoint → HTTP ${res.status} ${json.error ?? ''} ${json.error_description ?? ''}`.trim());
  }
  return json;
}

export function exchangeCode(cfg, { code, redirectUri }) {
  return tokenPost(cfg, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });
}

/** Rotation stricte : le refresh_token renvoyé REMPLACE l'ancien (persistance obligatoire). */
export function refreshToken(cfg, refreshTokenValue) {
  return tokenPost(cfg, { grant_type: 'refresh_token', refresh_token: refreshTokenValue });
}

// ── Client API v2 ─────────────────────────────────────────────────────────────
export class PennylaneClient {
  constructor(cfg, accessToken, { companyIdHeader = null, fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.token = accessToken;
    this.companyIdHeader = companyIdHeader;
    this.fetchImpl = fetchImpl;
    this.onTokenRefreshed = null; // callback(tokenResponse) — rotation persistée par le service
  }

  async request(path, { query = {}, tries = 3 } = {}) {
    const url = new URL(this.cfg.pennylane.apiUrl.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(query)) {
      if (v != null) url.searchParams.set(k, String(v));
    }
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
    };
    if (this.companyIdHeader) headers['X-Company-Id'] = this.companyIdHeader;
    const res = await this.fetchImpl(url, { headers });
    if (res.status === 429 && tries > 1) {
      const wait = Math.min(30, Number(res.headers.get('retry-after')) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      return this.request(path, { query, tries: tries - 1 });
    }
    if (res.status === 401 && this.onTokenRefreshed) {
      await this.onTokenRefreshed(); // une seule tentative de refresh par appel
      this.onTokenRefreshed = null;
      return this.request(path, { query });
    }
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch { /* ci-dessous */ }
    if (!res.ok) {
      throw new PennylaneError(res.status, json.error || 'api_error',
        `Pennylane ${path} → HTTP ${res.status} : ${text.slice(0, 200)}`);
    }
    return json;
  }

  getCustomerInvoicesPage(cursor, limit = 100) {
    return this.request('/customer_invoices', { query: { cursor, limit } });
  }
  getTransactionsPage(cursor, limit = 100) {
    return this.request('/transactions', { query: { cursor, limit } });
  }
  getCustomersPage(cursor, limit = 100) {
    return this.request('/customers', { query: { cursor, limit } });
  }
}

// ── Mapping v2 → domaine moteur (contrat Invoice/Payment, centimes entiers) ───
const OPEN_STATUSES = new Set(['upcoming', 'late', 'partially_paid']);

function eurosToCents(s) {
  // La doc v2 livre des chaînes décimales ("120.00") ; Number puis arrondi — centimes exacts.
  const n = Number(String(s).replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function mapInvoice(raw) {
  if (!OPEN_STATUSES.has(raw.status)) return { ok: false, reason: `status « ${raw.status} » hors périmètre (fermée/brouillon/avoir)` };
  const currency = String(raw.currency || 'EUR').toUpperCase();
  if (currency !== 'EUR' && currency !== 'USD') {
    return { ok: false, reason: `devise ${currency} non supportée par le moteur — écartée (aucune conversion implicite)` };
  }
  const amountSource = currency === 'EUR' ? raw.amount : raw.currency_amount;
  const cents = eurosToCents(amountSource);
  if (cents == null || cents <= 0) return { ok: false, reason: `montant illisible ou non positif (${amountSource})` };
  if (!raw.invoice_number) return { ok: false, reason: 'invoice_number absent' };
  const issueDate = raw.date;
  const dueDate = raw.deadline;
  const warnings = [];
  let due = dueDate;
  if (!due && issueDate) {
    due = new Date(new Date(issueDate).getTime() + 30 * 86400000).toISOString().slice(0, 10);
    warnings.push(`facture ${raw.invoice_number} : deadline absente — échéance approximée à émission + 30 j`);
  }
  if (!issueDate) return { ok: false, reason: 'date d’émission absente' };
  return {
    ok: true,
    warnings,
    invoice: {
      id: String(raw.id),
      number: raw.invoice_number,
      customer: raw.customerName ?? `Client #${raw.customer?.id ?? 'inconnu'}`,
      customerReference: raw.external_reference ?? null,
      amountCents: cents,
      currency,
      issueDate,
      dueDate: due,
      open: true,
    },
  };
}

export function mapTransaction(raw) {
  const label = raw.label;
  if (!label || !String(label).trim()) return { ok: false, reason: 'libellé absent' };
  const currency = String(raw.currency || 'EUR').toUpperCase();
  if (currency !== 'EUR' && currency !== 'USD') {
    return { ok: false, reason: `devise ${currency} non supportée — écartée` };
  }
  const amountSource = currency === 'EUR' ? raw.amount : raw.currency_amount;
  const cents = eurosToCents(amountSource);
  if (cents == null || cents === 0) return { ok: false, reason: `montant illisible ou nul (${amountSource})` };
  if (!raw.date) return { ok: false, reason: 'date absente' };
  // Convention de signe non documentée côté Pennylane : transmise telle quelle —
  // à confirmer sur données réelles en pilote (rejets = négatifs attendus).
  return { ok: true, warnings: [], payment: { id: String(raw.id), label, amountCents: cents, currency, date: raw.date } };
}

// ── Connexion + synchronisation (PostgreSQL, jetons chiffrés au repos) ────────
export async function saveConnection(db, cfg, companyId, tokenResponse) {
  const accessExp = new Date(Date.now() + (Number(tokenResponse.expires_in) || 86400) * 1000);
  const refreshExp = new Date(Date.now() + (Number(tokenResponse.refresh_token_expires_in) || 7862400) * 1000);
  await db.query(
    `INSERT INTO pennylane_connections (company_id, access_token_enc, refresh_token_enc, access_expires_at, refresh_expires_at, status)
     VALUES ($1, $2, $3, $4, $5, 'connected')
     ON CONFLICT (company_id) DO UPDATE SET
       access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
       access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
       status = 'connected', updated_at = now()`,
    [companyId,
     encryptSecret(tokenResponse.access_token, cfg.appSecretKey),
     encryptSecret(tokenResponse.refresh_token, cfg.appSecretKey),
     accessExp.toISOString(), refreshExp.toISOString()],
  );
}

async function loadConnection(db, cfg, companyId) {
  const rows = await db.query('SELECT * FROM pennylane_connections WHERE company_id = $1', [companyId]);
  const row = rows[0];
  if (!row) throw new PennylaneError(404, 'not_connected', 'aucune connexion Pennylane — passer par /api/integrations/pennylane/authorize');
  let accessToken = decryptSecret(row.access_token_enc, cfg.appSecretKey);
  let refreshTokenValue = decryptSecret(row.refresh_token_enc, cfg.appSecretKey);
  const expiringSoon = new Date(row.access_expires_at).getTime() < Date.now() + 60000;
  if (expiringSoon) {
    const fresh = await refreshToken(cfg, refreshTokenValue);
    if (!fresh.refresh_token) {
      throw new PennylaneError(401, 'refresh_invalid', 'refresh_token sans rotation — reconnexion requise');
    }
    accessToken = fresh.access_token;
    refreshTokenValue = fresh.refresh_token; // rotation stricte : le nouveau remplace l'ancien
    await saveConnection(db, cfg, companyId, fresh);
  }
  return { accessToken, refreshTokenValue };
}

export async function connectionStatus(db, cfg, companyId) {
  const rows = await db.query(
    'SELECT status, access_expires_at, refresh_expires_at, updated_at FROM pennylane_connections WHERE company_id = $1',
    [companyId],
  );
  if (!rows[0]) return { connected: false };
  return { connected: true, status: rows[0].status, accessExpiresAt: rows[0].access_expires_at, updated: rows[0].updated_at };
}

/** Synchronisation réelle : factures ouvertes + transactions bancaires → portefeuille de l'entreprise. */
export async function pennylaneSync(db, companyId, cfg, { fetchImpl = fetch } = {}) {
  requireConfigured(cfg);
  const { accessToken: initialToken, refreshTokenValue: initialRefresh } = await loadConnection(db, cfg, companyId);
  let currentRefresh = initialRefresh;
  const client = new PennylaneClient(cfg, initialToken, { fetchImpl });
  // Jeton révoqué côté fournisseur en pleine vie (401) → rotation du refresh,
  // persistance immédiate du couple neuf, relance de la requête (une seule fois).
  client.onTokenRefreshed = async () => {
    const fresh = await refreshToken(cfg, currentRefresh);
    if (!fresh.refresh_token) {
      throw new PennylaneError(401, 'refresh_invalid', 'rotation sans nouveau refresh_token — reconnexion requise');
    }
    currentRefresh = fresh.refresh_token;
    client.token = fresh.access_token;
    await saveConnection(db, cfg, companyId, fresh);
  };

  const report = {
    invoices: { kept: 0, skippedClosed: 0, skippedCurrency: 0, skippedShape: 0 },
    payments: { kept: 0, skippedCurrency: 0, skippedShape: 0 },
    warnings: [], pages: { invoices: 0, transactions: 0, customers: 0 },
  };

  // Répertoire clients (nom réel de la facture) — champ id/name mappé défensivement.
  const customerNames = new Map();
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const res = await client.getCustomersPage(cursor).catch((e) => {
      report.warnings.push(`répertoire clients indisponible (${e.message}) — noms de repli « Client #id »`);
      return null;
    });
    if (!res) break;
    report.pages.customers++;
    for (const c of res.items ?? []) {
      if (c?.id != null) customerNames.set(String(c.id), c.name ?? c.company_name ?? `Client #${c.id}`);
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  // Factures clients ouvertes → invoices (source pennylane, upsert idempotent)
  cursor = null;
  for (let page = 0; page < 5; page++) {
    const res = await client.getCustomerInvoicesPage(cursor);
    report.pages.invoices++;
    for (const raw of res.items ?? []) {
      const rawNamed = { ...raw, customerName: customerNames.get(String(raw.customer?.id)) };
      const m = mapInvoice(rawNamed);
      if (!m.ok) {
        if (m.reason.includes('devise')) report.invoices.skippedCurrency++;
        else if (m.reason.includes('hors périmètre')) report.invoices.skippedClosed++;
        else report.invoices.skippedShape++;
        if (m.reason.includes('hors périmètre') === false) report.warnings.push(`facture ${raw.invoice_number ?? raw.id} : ${m.reason}`);
        continue;
      }
      report.warnings.push(...m.warnings);
      await db.query(
        `INSERT INTO invoices (company_id, source, external_id, number, customer, customer_reference, amount_cents, currency, issue_date, due_date, open)
         VALUES ($1, 'pennylane', $2, $3, $4, $5, $6, $7, $8, $9, true)
         ON CONFLICT (company_id, source, external_id) DO UPDATE SET
           number = EXCLUDED.number, customer = EXCLUDED.customer, customer_reference = EXCLUDED.customer_reference,
           amount_cents = EXCLUDED.amount_cents, currency = EXCLUDED.currency,
           issue_date = EXCLUDED.issue_date, due_date = EXCLUDED.due_date, open = true`,
        [companyId, m.invoice.id, m.invoice.number, m.invoice.customer, m.invoice.customerReference,
         m.invoice.amountCents, m.invoice.currency, m.invoice.issueDate, m.invoice.dueDate],
      );
      report.invoices.kept++;
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  // Transactions bancaires → payments (source pennylane, upsert idempotent)
  cursor = null;
  for (let page = 0; page < 5; page++) {
    const res = await client.getTransactionsPage(cursor);
    report.pages.transactions++;
    for (const raw of res.items ?? []) {
      const m = mapTransaction(raw);
      if (!m.ok) {
        if (m.reason.includes('devise')) report.payments.skippedCurrency++;
        else report.payments.skippedShape++;
        report.warnings.push(`transaction ${raw.id} : ${m.reason}`);
        continue;
      }
      await db.query(
        `INSERT INTO payments (company_id, source, external_id, label, amount_cents, currency, date)
         VALUES ($1, 'pennylane', $2, $3, $4, $5, $6)
         ON CONFLICT (company_id, source, external_id) DO UPDATE SET
           label = EXCLUDED.label, amount_cents = EXCLUDED.amount_cents,
           currency = EXCLUDED.currency, date = EXCLUDED.date`,
        [companyId, m.payment.id, m.payment.label, m.payment.amountCents, m.payment.currency, m.payment.date],
      );
      report.payments.kept++;
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }

  await appendAudit(db, companyId, 'integration.sync', { provider: 'pennylane', report, at: nowIso() });
  return report;
}
