'use strict';
// Journal d'audit chaîné par entreprise — le même mécanisme que le grand livre
// de la page publique : hash = sha256(seq | prev_hash | kind | payload | ts),
// genesis « CLEARMATCH-GENESIS ». Append-only : aucune mise à jour, jamais.
import { sha256hex, stableJson, nowIso } from './util.js';

export const GENESIS = 'CLEARMATCH-GENESIS';

export function computeHash(seq, prevHash, kind, payload, ts) {
  return sha256hex(`${seq}|${prevHash}|${kind}|${stableJson(payload)}|${ts}`);
}

/** Ajoute un événement scellé ; séquence allouée sous verrou d'entreprise (parallélisme sûr). */
export async function appendAudit(db, companyId, kind, payload = {}, ts = nowIso()) {
  return db.tx(async (q) => {
    await q('SELECT pg_advisory_xact_lock($1, 7)', [companyId]);
    const rows = await q(
      'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM audit_events WHERE company_id = $1',
      [companyId],
    );
    const seq = rows[0].max_seq + 1;
    const prev = seq === 1
      ? GENESIS
      : (await q('SELECT hash FROM audit_events WHERE company_id = $1 AND seq = $2', [companyId, seq - 1]))[0].hash;
    const hash = computeHash(seq, prev, kind, payload, ts);
    await q(
      `INSERT INTO audit_events (company_id, seq, kind, payload, prev_hash, hash, ts)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [companyId, seq, kind, JSON.stringify(payload), prev, hash, ts],
    );
    return { seq, hash };
  });
}

export async function listAudit(db, companyId, limit = 200) {
  return db.query(
    'SELECT seq, kind, payload, prev_hash, hash, ts FROM audit_events WHERE company_id = $1 ORDER BY seq LIMIT $2',
    [companyId, limit],
  );
}

/** Revérifie toute la chaîne depuis la genesis ; renvoie la première rupture le cas échéant.
 *  Robuste aux types drivers : payload peut revenir en chaîne (jsonb), ts en objet Date. */
export async function verifyChain(db, companyId) {
  const events = await listAudit(db, companyId, 1000000);
  let prev = GENESIS;
  for (const e of events) {
    const payload = typeof e.payload === 'string' ? JSON.parse(e.payload) : e.payload;
    const ts = e.ts instanceof Date ? e.ts.toISOString() : new Date(e.ts).toISOString();
    const expected = computeHash(e.seq, prev, e.kind, payload, ts);
    if (expected !== e.hash || e.prev_hash !== prev) {
      return { ok: false, checked: events.length, brokenAt: e.seq };
    }
    prev = e.hash;
  }
  return { ok: true, checked: events.length, brokenAt: null };
}
