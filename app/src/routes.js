'use strict';
// Routeur ClearMatch App — toutes les routes /api. JSON partout, erreurs enveloppées
// { error: { code, message } }, isolation par entreprise sur chaque accès.
import {
  registerUser, loginUser, createSession, sessionCookie, clearSessionCookie,
  userFromRequest, destroySession, requireMembership, checkCsrf, rateLimit,
  clientIp, HttpError,
} from './auth.js';
import * as svc from './engine/service.js';
import * as auditMod from './audit.js';
import * as billing from './billing.js';
import * as pl from './integrations/pennylane.js';
import { newState, constantTimeEquals, nowIso } from './util.js';

const seg = (p) => p.split('/').filter(Boolean);
const int = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'invalid_id', 'identifiant invalide');
  return n;
};

/** Export intégral d'une entreprise (RGPD portabilité + reçu de suppression). */
async function exportCompany(db, companyId) {
  const company = (await db.query('SELECT id, name, owner_user_id, created_at FROM companies WHERE id = $1', [companyId]))[0] ?? null;
  const [memberships, invoices, payments, exceptions, journal, subscription, links, audit] = await Promise.all([
    db.query('SELECT user_id, role FROM memberships WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM invoices WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM payments WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM exceptions WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM journal_entries WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM subscriptions WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM payment_links WHERE company_id = $1', [companyId]),
    db.query('SELECT * FROM audit_events WHERE company_id = $1 ORDER BY seq', [companyId]),
  ]);
  return { company, memberships, invoices, payments, exceptions, journal_entries: journal, subscriptions: subscription, payment_links: links, audit_events: audit };
}

export async function route({ method, path, query, body, req, db, cfg, user }) {
  const parts = seg(path);
  const j = (status, json, headers = []) => ({ status, json, headers });

  // ── santé ───────────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/healthz') {
    await db.ping();
    return j(200, { ok: true, at: nowIso() });
  }

  // ── webhooks (auth = signature ; CSRF/session sans objet) ───────────────────
  if (method === 'POST' && path === '/api/webhooks/saspay') {
    const res = await billing.processSaspayWebhook(db, cfg, {
      rawBody: body.raw, signatureHeader: req.headers['x-webhook-signature'],
      timestampHeader: req.headers['x-webhook-timestamp'],
    });
    if (res.accepted === false && res.invalid) {
      // signature/âge/enveloppe invalides : 401 pour que le fournisseur retente avec backoff
      return j(401, { error: { code: 'invalid_signature', message: res.reason } });
    }
    return j(200, res);
  }

  // ── admin (cron externe) ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/admin/scheduler/tick') {
    if (!cfg.adminToken) throw new HttpError(503, 'admin_disabled', 'ADMIN_TOKEN non configuré — tick indisponible');
    if (!constantTimeEquals(req.headers['x-admin-token'] || '', cfg.adminToken)) {
      throw new HttpError(401, 'bad_admin_token', 'jeton admin invalide');
    }
    const now = body.json?.now ? new Date(body.json.now) : new Date();
    return j(200, await billing.schedulerTick(db, cfg, now));
  }

  // ── authentification ────────────────────────────────────────────────────────
  if (path === '/api/auth/register' && method === 'POST') {
    rateLimit(`reg:${clientIp(req)}`, 10, 60000);
    checkCsrf(req);
    const u = await registerUser(db, body.json ?? {});
    const s = await createSession(db, u.id);
    return j(201, { user: u }, [['Set-Cookie', sessionCookie(s.token)]]);
  }
  if (path === '/api/auth/login' && method === 'POST') {
    rateLimit(`login:${clientIp(req)}`, 10, 60000);
    checkCsrf(req);
    const u = await loginUser(db, body.json ?? {});
    const s = await createSession(db, u.id);
    return j(200, { user: u }, [['Set-Cookie', sessionCookie(s.token)]]);
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    checkCsrf(req);
    await destroySession(db, req);
    return j(200, { ok: true }, [['Set-Cookie', clearSessionCookie()]]);
  }
  // RGPD — suppression du compte utilisateur : possible seulement sans entreprise détenue
  // (les entreprises sont supprimées individuellement d'abord, avec reçu d'export).
  if (path === '/api/auth/me' && method === 'DELETE') {
    checkCsrf(req);
    const owned = await db.query(
      "SELECT 1 FROM memberships WHERE user_id = $1 AND role = 'owner' LIMIT 1",
      [user.id],
    );
    if (owned.length) {
      throw new HttpError(409, 'has_companies', 'supprimez d’abord vos entreprises (export + suppression disponibles par entreprise)');
    }
    await db.query('DELETE FROM memberships WHERE user_id = $1', [user.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [user.id]);
    await db.query('DELETE FROM users WHERE id = $1', [user.id]);
    return j(200, { deleted: true }, [['Set-Cookie', clearSessionCookie()]]);
  }
  if (path === '/api/me' && method === 'GET') {
    if (!user) return j(401, { error: { code: 'not_logged_in', message: 'session requise' } });
    const companies = await db.query(
      `SELECT c.id, c.name, m.role, s.status AS subscription_status
       FROM companies c JOIN memberships m ON m.company_id = c.id
       LEFT JOIN subscriptions s ON s.company_id = c.id
       WHERE m.user_id = $1 ORDER BY c.id`,
      [user.id],
    );
    return j(200, { user, companies });
  }

  if (!user) throw new HttpError(401, 'not_logged_in', 'session requise');

  // ── entreprises ─────────────────────────────────────────────────────────────
  if (path === '/api/companies' && method === 'POST') {
    checkCsrf(req);
    const name = String(body.json?.name ?? '').trim();
    if (!name) throw new HttpError(400, 'invalid_name', 'nom d’entreprise requis');
    const rows = await db.query('INSERT INTO companies (name, owner_user_id) VALUES ($1, $2) RETURNING id, name', [name, user.id]);
    const c = rows[0];
    await db.query('INSERT INTO memberships (company_id, user_id, role) VALUES ($1, $2, $3)', [c.id, user.id, 'owner']);
    await auditMod.appendAudit(db, c.id, 'company.created', { name, by: user.id });
    return j(201, { company: c });
  }

  if (parts[0] === 'api' && parts[1] === 'companies' && parts.length >= 3) {
    const companyId = int(parts[2]);
    await requireMembership(db, companyId, user.id);
    const rest = parts.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        const c = (await db.query('SELECT id, name, created_at FROM companies WHERE id = $1', [companyId]))[0];
        if (!c) throw new HttpError(404, 'not_found', 'entreprise introuvable');
        return j(200, { company: c });
      }
      // RGPD — suppression de l'entreprise : reçu d'export renvoyé AVANT destruction
      // (cascades PostgreSQL : factures, opérations, exceptions, audit chaîné, abonnement).
      if (method === 'DELETE') {
        checkCsrf(req);
        await requireMembership(db, companyId, user.id, ['owner']);
        const dump = await exportCompany(db, companyId);
        const lastHash = dump.audit_events.at(-1)?.hash ?? null;
        await db.query('DELETE FROM companies WHERE id = $1', [companyId]);
        return j(200, {
          deleted: true, companyId, receipt: { exportedAt: nowIso(), lastAuditHash: lastHash, data: dump },
          note: 'reçu de suppression : snapshot complet + dernier sceau d’audit, à archiver hors ClearMatch',
        });
      }
    }

    // RGPD — export intégral des données de l'entreprise (portabilité, article 20)
    if (rest[0] === 'export' && method === 'POST') {
      checkCsrf(req);
      await requireMembership(db, companyId, user.id, ['owner']);
      return j(200, { exportedAt: nowIso(), data: await exportCompany(db, companyId) });
    }

    // portefeuille & moteur
    if (rest[0] === 'seed-demo' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      const res = await svc.seedDemo(db, companyId, cfg);
      return j(200, res);
    }
    if (rest[0] === 'import-invoices' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      return j(200, await svc.importInvoices(db, companyId, body.json?.invoices ?? [], 'manual'));
    }
    if (rest[0] === 'import-payments' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      return j(200, await svc.importPayments(db, companyId, body.json?.payments ?? [], 'manual'));
    }
    if (rest[0] === 'analyze' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      const r = await svc.analyzeLive(db, companyId, cfg, body.json ?? {});
      return j(200, { result: r });
    }
    if (rest[0] === 'reanalyze' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      return j(200, await svc.reanalyze(db, companyId, cfg));
    }
    if (rest[0] === 'exceptions' && method === 'GET') {
      const status = query.get('status');
      const rows = await db.query(
        `SELECT e.id, e.decision, e.classification, e.status, e.result, e.created_at,
                p.label, p.amount_cents, p.currency, p.date
         FROM exceptions e JOIN payments p ON p.id = e.payment_row_id
         WHERE e.company_id = $1 ${status ? 'AND e.status = $2' : ''}
         ORDER BY e.id LIMIT 500`,
        status ? [companyId, status] : [companyId],
      );
      return j(200, { exceptions: rows });
    }

    // audit + journal
    if (rest[0] === 'audit' && method === 'GET') {
      return j(200, { events: await auditMod.listAudit(db, companyId) });
    }
    if (rest[0] === 'audit' && rest[1] === 'verify' && method === 'POST') {
      checkCsrf(req);
      return j(200, await auditMod.verifyChain(db, companyId));
    }
    if (rest[0] === 'journal' && method === 'GET') {
      const rows = await db.query(
        `SELECT j.id, j.lines, j.note, j.created_at, e.classification
         FROM journal_entries j JOIN exceptions e ON e.id = j.exception_id
         WHERE j.company_id = $1 ORDER BY j.id`,
        [companyId],
      );
      return j(200, { entries: rows });
    }

    // abonnement
    if (rest[0] === 'subscription' && method === 'GET') {
      return j(200, await billing.getSubscription(db, companyId));
    }
    if (rest[0] === 'subscription' && rest.length === 1 && method === 'POST') {
      checkCsrf(req);
      await requireMembership(db, companyId, user.id, ['owner']);
      return j(200, await billing.subscribe(db, cfg, companyId, String(body.json?.plan ?? '')));
    }
    // rapprochement HUMAIN d'un lien « candidate » (mode manuel, sans vérification fournisseur)
    if (rest[0] === 'subscription' && rest[1] === 'confirm-payment' && method === 'POST') {
      checkCsrf(req);
      await requireMembership(db, companyId, user.id, ['owner', 'accountant']);
      const res = await billing.confirmManualPayment(db, cfg, companyId, user.id, {
        linkId: int(String(body.json?.linkId ?? '')),
        transactionRef: String(body.json?.transactionRef ?? ''),
        note: String(body.json?.note ?? ''),
      });
      return j(200, res);
    }

    throw new HttpError(404, 'not_found', `route inconnue : ${method} ${path}`);
  }

  // ── décision humaine sur une exception ──────────────────────────────────────
  if (parts[0] === 'api' && parts[1] === 'exceptions' && parts[3] === 'decision' && method === 'POST') {
    checkCsrf(req);
    const exceptionId = int(parts[2]);
    const owner = (await db.query('SELECT company_id FROM exceptions WHERE id = $1', [exceptionId]))[0];
    if (!owner) throw new HttpError(404, 'not_found', 'exception introuvable');
    // existence cachée aux non-membres (404, jamais 403 : pas de sonde d'ids) ;
    // un membre au rôle insuffisant garde son 403 explicite (forbidden_role)
    try {
      await requireMembership(db, owner.company_id, user.id, ['owner', 'accountant']);
    } catch (e) {
      if (e.code === 'not_member') throw new HttpError(404, 'not_found', 'exception introuvable');
      throw e;
    }
    await billing.assertNotSuspended(db, cfg, owner.company_id);
    const res = await svc.decide(db, owner.company_id, exceptionId, body.json ?? {}, user.id, cfg);
    return j(200, res);
  }

  // ── intégration Pennylane ───────────────────────────────────────────────────
  if (parts[1] === 'integrations' && parts[2] === 'pennylane') {
    if (parts[3] === 'callback' && method === 'GET') {
      // pas de company_id ici : il vient de l'état jetable (anti-CSRF)
      const code = query.get('code');
      const state = query.get('state');
      const error = query.get('error');
      if (error) return { status: 302, redirect: `/#integrations&msg=${encodeURIComponent(`Pennylane : ${error}`)}` };
      const st = (await db.query('SELECT * FROM oauth_states WHERE state = $1', [state ?? '']))[0];
      if (!st) throw new HttpError(400, 'bad_state', 'state OAuth inconnu ou déjà utilisé (anti-CSRF)');
      await db.query('DELETE FROM oauth_states WHERE state = $1', [state]); // jetable
      await requireMembership(db, st.company_id, user.id);
      const tokens = await pl.exchangeCode(cfg, { code, redirectUri: st.redirect_uri });
      await pl.saveConnection(db, cfg, st.company_id, tokens);
      await auditMod.appendAudit(db, st.company_id, 'integration.connected', {
        provider: 'pennylane', scopes: cfg.pennylane.scopes, at: nowIso(),
      });
      return { status: 302, redirect: '/#integrations' };
    }

    const companyId = int(query.get('company_id'));
    await requireMembership(db, companyId, user.id);

    if (parts[3] === 'status' && method === 'GET') {
      return j(200, await pl.connectionStatus(db, cfg, companyId));
    }
    if (parts[3] === 'authorize' && method === 'GET') {
      pl.requireConfigured(cfg);
      const redirectUri = `${cfg.pennylane.redirectBase.replace(/\/$/, '')}/api/integrations/pennylane/callback`;
      const state = newState();
      await db.query('INSERT INTO oauth_states (state, company_id, redirect_uri) VALUES ($1, $2, $3)',
        [state, companyId, redirectUri]);
      const url = pl.authorizeUrl(cfg, { redirectUri, state });
      return { status: 302, redirect: url };
    }
    if (parts[3] === 'sync' && method === 'POST') {
      checkCsrf(req);
      await billing.assertNotSuspended(db, cfg, companyId);
      const report = await pl.pennylaneSync(db, companyId, cfg);
      return j(200, report);
    }
    // déconnexion : révocation distante (au mieux) + destruction des jetons locaux
    if (parts[3] === 'disconnect' && method === 'POST') {
      checkCsrf(req);
      await requireMembership(db, companyId, user.id, ['owner']);
      return j(200, await pl.disconnectConnection(db, cfg, companyId));
    }
  }

  throw new HttpError(404, 'not_found', `route inconnue : ${method} ${path}`);
}
