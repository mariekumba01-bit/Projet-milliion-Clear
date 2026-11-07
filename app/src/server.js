'use strict';
// Serveur HTTP ClearMatch App — node:http brut (0 dépendance framework), JSON
// d'API + UI single-file servie statiquement. Testable : createApp() est pur,
// listen() séparé pour les tests E2E et la production.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { route } from './routes.js';
import { userFromRequest, HttpError } from './auth.js';
import { isProd } from './config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', 'public');

export function createApp({ db, cfg }) {
  let uiCache = null;

  async function readJsonBody(req, limit = 2 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > limit) throw new HttpError(413, 'payload_too_large', 'corps trop volumineux (limite 2 Mo)');
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return { json: {} };
    try { return { json: JSON.parse(raw) }; } catch {
      throw new HttpError(400, 'bad_json', 'corps JSON illisible');
    }
  }

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    try {
      // UI statique (single-file) — cache désactivé : le produit évolue vite.
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        uiCache ??= await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(uiCache);
        return;
      }

      if (!path.startsWith('/api/') && path !== '/healthz') throw new HttpError(404, 'not_found', 'ressource inconnue');

      const isWebhook = path === '/api/webhooks/saspay';
      let body;
      if (isWebhook) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = { raw: Buffer.concat(chunks).toString('utf8') };
      } else if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
        body = await readJsonBody(req);
      } else {
        body = { json: {} };
      }

      const user = await userFromRequest(db, req);
      const out = await route({
        method: req.method, path, query: url.searchParams, body, req, db, cfg, user,
      });

      if (out.redirect) {
        res.writeHead(out.status ?? 302, { Location: out.redirect });
        res.end();
        return;
      }
      res.writeHead(out.status ?? 200, {
        'Content-Type': 'application/json; charset=utf-8',
        ...Object.fromEntries(out.headers ?? []),
      });
      res.end(JSON.stringify(out.json ?? {}));
    } catch (err) {
      if (err instanceof HttpError) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
      } else {
        console.error(JSON.stringify({ level: 'error', path, msg: err.message, stack: err.stack?.split('\n')[1], at: new Date().toISOString() }));
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { code: 'internal', message: 'erreur interne — journalisée côté serveur' } }));
      }
    } finally {
      const ms = Date.now() - started;
      if (!path.startsWith('/api/webhooks')) {
        console.log(JSON.stringify({ level: 'info', method: req.method, path, status: res.statusCode, ms, at: new Date().toISOString() }));
      }
    }
  });

  return server;
}

// ── point d'entrée production ────────────────────────────────────────────────
export async function main() {
  const { config } = await import('./config.js');
  const { Db, initPglite } = await import('./db.js');
  if (config.databaseUrl.startsWith('pglite')) {
    await initPglite();
    console.log(JSON.stringify({ level: 'warn', msg: 'PostgreSQL embarqué (pglite) — réservé au dev/tests ; utiliser DATABASE_URL postgres:// en production' }));
  }
  const db = new Db(config.databaseUrl);
  await db.migrate();
  const server = createApp({ db, cfg: config });
  server.listen(config.port, () => {
    console.log(JSON.stringify({ level: 'info', msg: `ClearMatch App prête sur :${config.port}`, env: config.env, db: db.mode }));
  });

  // Ordonnanceur interne optionnel (production recommandée : cron externe sur /api/admin/scheduler/tick)
  const every = Number(process.env.SCHEDULER_INTERVAL_SECONDS || 0);
  if (every > 0) {
    const timer = setInterval(async () => {
      try {
        const { schedulerTick } = await import('./billing.js');
        const r = await schedulerTick(db, config);
        if (r.actions.length) console.log(JSON.stringify({ level: 'info', msg: 'scheduler', actions: r.actions }));
      } catch (e) {
        console.error(JSON.stringify({ level: 'error', msg: `scheduler: ${e.message}` }));
      }
    }, every * 1000);
    timer.unref();
  }

  const shutdown = async () => {
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
