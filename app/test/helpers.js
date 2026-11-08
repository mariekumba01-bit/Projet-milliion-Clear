'use strict';
// Helpers de test : serveur réel (HTTP + PostgreSQL embarqué pglite) sur port éphémère.
// L'environnement est posé AVANT tout import dynamique des modules applicatifs.
process.env.NODE_ENV = 'test';
process.env.APP_SECRET_KEY ||= 'a'.repeat(32);
process.env.SASPAY_WEBHOOK_SECRET ||= 'whsec_test_2026';
process.env.BILLING_ENFORCE ||= '1';

const ENV_DEFAULTS = {
  // réinitialise les intégrations et l'admin à chaque boot : aucun env ne fuite d'un test à l'autre
  ADMIN_TOKEN: '',
  SASPAY_API_KEY: '', SASPAY_BASE_URL: '',
  PENNYLANE_CLIENT_ID: '', PENNYLANE_CLIENT_SECRET: '',
  PENNYLANE_AUTH_URL: '', PENNYLANE_TOKEN_URL: '', PENNYLANE_API_URL: '',
  PENNYLANE_REDIRECT_BASE: '', PENNYLANE_REVOKE_URL: '',
};

export async function boot(overrides = {}) {
  for (const [k, v] of Object.entries({ ...ENV_DEFAULTS, ...overrides })) process.env[k] = v;
  const { initPglite, Db } = await import('../src/db.js');
  const { createApp } = await import('../src/server.js');
  const { config, deriveFromEnv } = await import('../src/config.js');
  // cache de module : réaligne l'objet config vivant avec l'environnement courant
  Object.assign(config, deriveFromEnv());
  await initPglite();
  const db = new Db('pglite::memory:');
  await db.migrate();
  const server = createApp({ db, cfg: config });
  const listenPort = overrides.PORT_TEST ?? 0;
  await new Promise((r) => server.listen(listenPort, '127.0.0.1', r));
  const port = server.address().port;
  return {
    db, config, port, server,
    async close() { await new Promise((r) => server.close(r)); await db.close(); },
  };
}

/** Client HTTP avec session persistante (cookie), CSRF auto pour les mutations. */
export function client(port) {
  let cookie = '';
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json', 'x-clearmatch-csrf': '1' } : {}),
        ...(cookie ? { cookie } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setc = res.headers.get('set-cookie');
    if (setc) cookie = setc.split(';')[0];
    let json = null;
    try { json = await res.json(); } catch { /* réponses 302 sans corps */ }
    return { status: res.status, json, headers: res.headers };
  };
  call.cookieHeader = () => cookie; // pour les fetch bruts (callbacks OAuth, redirections)
  return call;
}

/** Webhook SasPay signé (HMAC sur corps brut, comme le ferait le fournisseur).
 *  sendBody : corps DIFFÉRENT de celui signé (simule un payload falsifié après signature). */
export async function postSignedWebhook(port, payloadObj, { secret = 'whsec_test_2026', tsOffset = 0, sigOverride, tsOverride, sendBody } = {}) {
  const { createHmac } = await import('node:crypto');
  const rawBody = JSON.stringify(payloadObj);
  const sentRaw = sendBody ?? rawBody;
  const ts = Math.floor(Date.now() / 1000) + tsOffset;
  const sig = sigOverride ?? createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const res = await fetch(`http://127.0.0.1:${port}/api/webhooks/saspay`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webhook-Signature': sig,
      'X-Webhook-Timestamp': String(tsOverride ?? ts),
      'X-Webhook-Event': payloadObj?.event ?? 'webhook.test',
    },
    body: sentRaw,
  });
  let json = null;
  try { json = await res.json(); } catch { /* sans corps */ }
  return { status: res.status, json };
}

/** Fournisseur SasPay de test : implémente POST /payment-links/ et
 *  GET /payment-links/{id}/transactions/ (contrat OpenAPI v1.0.0) pour tester la
 *  réconciliation par identifiants fournisseur. */
export async function startFakeSaspay() {
  const http = await import('node:http');
  const state = { nextLinkId: 100, linkTransactions: new Map(), linkRequests: [] };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/payment-links/' && req.method === 'POST') {
      let body = '';
      for await (const c of req) body += c;
      state.linkRequests.push(JSON.parse(body || '{}'));
      const id = `pl_${state.nextLinkId++}`;
      state.linkTransactions.set(id, []);
      return send(200, { id, url: `https://pay.saspay.test/${id}` });
    }
    const m = url.pathname.match(/^\/payment-links\/([^/]+)\/transactions\/?$/);
    if (m && req.method === 'GET') {
      if (!state.linkTransactions.has(m[1])) return send(404, { error: 'link_not_found' });
      return send(200, { results: state.linkTransactions.get(m[1]) });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port, state,
    addTransaction(linkId, txn) { state.linkTransactions.get(linkId).push(txn); },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Fournisseur Pennylane de test : serveur HTTP local implémentant OAuth + API v2. */
export async function startFakePennylane() {
  const http = await import('node:http');
  const state = { refreshCount: 0, tokenRequests: [], lastAuth: null };
  const TOKEN = { access_token: 'at_fake_1', refresh_token: 'rt_fake_1', expires_in: 86400, refresh_token_expires_in: 7862400 };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (url.pathname === '/oauth/authorize') {
      state.lastAuth = Object.fromEntries(url.searchParams);
      res.writeHead(302, { Location: `${state.lastAuth.redirect_uri}?code=code_good&state=${state.lastAuth.state}` });
      res.end();
      return;
    }
    if (url.pathname === '/oauth/token') {
      let form = '';
      for await (const c of req) form += c;
      const params = Object.fromEntries(new URLSearchParams(form));
      state.tokenRequests.push({ grant_type: params.grant_type, code: params.code, refresh: params.refresh_token });
      if (params.grant_type === 'authorization_code') {
        if (params.code !== 'code_good' || params.client_id !== 'cid' || params.client_secret !== 'csecret') {
          return send(400, { error: 'invalid_grant' });
        }
        return send(200, TOKEN);
      }
      if (params.grant_type === 'refresh_token') {
        state.refreshCount++;
        if (params.refresh_token !== 'rt_fake_' + state.refreshCount) {
          return send(400, { error: 'invalid_grant', error_description: 'rotation stricte : ancien refresh invalide' });
        }
        return send(200, { ...TOKEN, access_token: `at_fake_${state.refreshCount + 1}`, refresh_token: `rt_fake_${state.refreshCount + 1}` });
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (url.pathname === '/oauth/revoke') {
      let form = '';
      for await (const c of req) form += c;
      const params = Object.fromEntries(new URLSearchParams(form));
      state.revoked = state.revoked ?? [];
      state.revoked.push(params.token);
      return send(200, {});
    }
    if (url.pathname === '/api/external/v2/customer_invoices') {
      // at_fake_1 (émis par l'échange initial) est révoqué côté fournisseur : 401 UNE fois,
      // pour exercer le chemin 401 → refresh rotation → retry. Les tokens suivants passent.
      if ((req.headers.authorization || '').includes('Bearer at_fake_1') && !state.stale401Done) {
        state.stale401Done = true;
        return send(401, { error: 'expired' });
      }
      return send(200, {
        has_more: false, next_cursor: null,
        items: [
          { id: 101, invoice_number: 'FA2026-0101', amount: '2400.00', currency: 'EUR', date: '2026-11-01', deadline: '2026-12-01', status: 'upcoming', customer: { id: 5, url: 'x' }, paid: false },
          { id: 102, invoice_number: 'FA2026-0102', amount: '500.00', currency: 'EUR', date: '2026-11-02', deadline: '2026-11-20', status: 'late', customer: { id: 5, url: 'x' } },
          { id: 103, invoice_number: 'FA2026-0103', amount: '99.00', currency_amount: '118.80', currency: 'USD', date: '2026-11-03', deadline: '2026-12-03', status: 'partially_paid', customer: { id: 6, url: 'x' } },
          { id: 104, invoice_number: 'FA2026-0104', amount: '78000.00', currency: 'XOF', date: '2026-11-04', deadline: '2026-12-04', status: 'upcoming', customer: { id: 7, url: 'x' } },
          { id: 105, invoice_number: 'FA2026-0105', amount: '300.00', currency: 'EUR', date: '2026-11-05', deadline: '2026-11-15', status: 'paid', customer: { id: 5, url: 'x' } },
          { id: 106, invoice_number: '', amount: '10.00', currency: 'EUR', date: '2026-11-06', deadline: '2026-12-06', status: 'upcoming', customer: { id: 5, url: 'x' } },
        ],
      });
    }
    if (url.pathname === '/api/external/v2/transactions') {
      return send(200, {
        has_more: false, next_cursor: null,
        items: [
          { id: 901, label: 'VIR SEPA RECU DE SARL BATIPLUS FACT FA2026-0101', amount: '2400.00', currency: 'EUR', date: '2026-11-20' },
          { id: 902, label: 'INCOMING WIRE USD FA2026-0103', amount: '118.80', currency_amount: '118.80', currency: 'USD', date: '2026-11-21' },
          { id: 903, label: 'VIR XOF SANS RAPPORT', amount: '5000.00', currency: 'XOF', date: '2026-11-22' },
          { id: 904, label: '', amount: '10.00', currency: 'EUR', date: '2026-11-23' },
        ],
      });
    }
    if (url.pathname === '/api/external/v2/customers') {
      return send(200, { has_more: false, next_cursor: null, items: [{ id: 5, name: 'SARL BATIPLUS' }, { id: 6, name: 'Meubles Delmas' }] });
    }
    send(404, { error: 'not_found' });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, state, close: () => new Promise((r) => server.close(r)) };
}
