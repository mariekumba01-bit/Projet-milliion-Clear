'use strict';
// Accès PostgreSQL double mode :
//  • DATABASE_URL postgres://…  → node-postgres (production, server PostgreSQL)
//  • DATABASE_URL pglite[:chemin] → PostgreSQL embarqué réel (WASM, dev/tests) — même SQL, jsonb inclus.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = join(dirname(fileURLToPath(import.meta.url)));

let PGliteC = null;

/** Charge dynamiquement @electric-sql/pglite une seule fois (requis avant Db en mode pglite). */
export async function initPglite() {
  if (!PGliteC) ({ PGlite: PGliteC } = await import('@electric-sql/pglite'));
}

export class Db {
  constructor(databaseUrl) {
    this.url = databaseUrl;
    if (databaseUrl.startsWith('pglite')) {
      if (!PGliteC) throw new Error('PGlite non initialisé — appelez initPglite() au démarrage');
      const path = databaseUrl.slice('pglite:'.length).trim();
      this.mode = 'pglite';
      this.client = path && path !== ':memory:' ? new PGliteC(path) : new PGliteC();
    } else {
      this.mode = 'postgres';
      this.pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
    }
  }

  async query(sql, params = []) {
    if (this.mode === 'pglite') {
      const res = await this.client.query(sql, params);
      return res.rows;
    }
    const res = await this.pool.query(sql, params);
    return res.rows;
  }

  /** Transaction : rollback automatique sur exception. */
  async tx(fn) {
    if (this.mode === 'pglite') {
      return this.client.transaction(async (q) => {
        const runner = async (sql, params) => (await q.query(sql, params)).rows;
        return fn(runner);
      });
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const rows = await fn(async (sql, params) => (await client.query(sql, params)).rows);
      await client.query('COMMIT');
      return rows;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async migrate() {
    const schema = readFileSync(join(HERE, 'schema.sql'), 'utf8');
    // exec = protocole simple, requis pour les scripts multi-instructions (PGlite) ;
    // sans paramètres, le pool pg accepte aussi le multi-instructions.
    if (this.mode === 'pglite') await this.client.exec(schema);
    else await this.pool.query(schema);
    await this.query(
      "INSERT INTO schema_meta (key, value) VALUES ('version', '1') ON CONFLICT (key) DO NOTHING",
    );
  }

  async close() {
    if (this.mode === 'pglite') await this.client.close();
    else await this.pool.end();
  }

  async ping() {
    await this.query('SELECT 1');
  }
}
