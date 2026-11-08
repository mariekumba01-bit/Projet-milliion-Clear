'use strict';
// Persistance et redémarrage réels : PostgreSQL embarqué (pglite) en MODE FICHIER —
// on arrête tout, on rouvre le même répertoire de données, et le monde a survécu
// (comptes, portefeuille, chaîne d'audit, session utilisateur).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.NODE_ENV = 'test';
process.env.APP_SECRET_KEY ||= 'a'.repeat(32);
process.env.SASPAY_WEBHOOK_SECRET ||= 'whsec_test_2026';

test('redémarrage complet : mêmes données, session encore valide, chaîne d’audit encore intègre', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clearmatch-pg-'));
  const url = `pglite:${dir}`;
  let cookie = '';
  let port = 0;

  {
    const { initPglite, Db } = await import('../src/db.js');
    const { createApp } = await import('../src/server.js');
    const { config, deriveFromEnv } = await import('../src/config.js');
    await initPglite();
    Object.assign(config, deriveFromEnv());
    const db = new Db(url);
    await db.migrate();
    const server = createApp({ db, cfg: config });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;

    const call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json', 'x-clearmatch-csrf': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const setc = res.headers.get('set-cookie');
      if (setc) cookie = setc.split(';')[0];
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    await call('POST', '/api/auth/register', { email: 'persist@test.fr', password: 'motdepasse10', name: 'P' });
    await call('POST', '/api/companies', { name: 'Persistance SARL' });
    await call('POST', '/api/companies/1/seed-demo', {});
    const ver = await call('POST', '/api/companies/1/audit/verify', {});
    assert.equal(ver.json.ok, true);

    await new Promise((r) => server.close(r));
    await db.close(); // ← ARRÊT PROCESSUS SIMULÉ
  }

  {
    // REDÉMARRAGE : nouveaux objets, même répertoire de données
    const { initPglite, Db } = await import('../src/db.js');
    const { createApp } = await import('../src/server.js');
    const { config, deriveFromEnv } = await import('../src/config.js');
    await initPglite();
    Object.assign(config, deriveFromEnv());
    const db = new Db(url);
    await db.migrate(); // idempotent sur une base existante
    const server = createApp({ db, cfg: config });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));

    const call = async (method, path, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
        method,
        headers: { ...(body !== undefined ? { 'content-type': 'application/json', 'x-clearmatch-csrf': '1' } : {}), ...(cookie ? { cookie } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, json: await res.json().catch(() => null) };
    };

    // utilisateur, session, portefeuille : tout a survécu
    const me = await call('GET', '/api/me');
    assert.equal(me.status, 200, 'la session survit au redémarrage');
    assert.equal(me.json.companies[0].name, 'Persistance SARL');
    const ex = await call('GET', '/api/companies/1/exceptions');
    assert.ok(ex.json.exceptions.length >= 20, 'les exceptions ont survécu');
    const ver = await call('POST', '/api/companies/1/audit/verify', {});
    assert.equal(ver.json.ok, true, 'la chaîne d’audit est intègre après redémarrage');
    const an = await call('POST', '/api/companies/1/analyze', { label: 'VIR RECU GAUTHIER ET FILS', amountEur: 3600 });
    assert.equal(an.status, 200, 'le moteur fonctionne normalement après redémarrage');

    await new Promise((r) => server.close(r));
    await db.close();
  }

  rmSync(dir, { recursive: true, force: true });
});
