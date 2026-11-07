// ─────────────────────────────────────────────────────────────────────────────
// Tests de la persistance fichier (src/store.ts) — la preuve exécutable qu'aucune
// base de données n'est nécessaire pour les pilotes : chaîne de hachage intègre,
// détection de falsification, tolérance aux crashs, snapshots atomiques.
// ─────────────────────────────────────────────────────────────────────────────
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditJournal, loadSnapshot, saveSnapshot, type JournalEntry } from '../src/store.ts';

const dir = mkdtempSync(join(tmpdir(), 'clearmatch-store-'));
const jfile = join(dir, 'audit.jsonl');
test.after(() => rmSync(dir, { recursive: true, force: true }));

test('store : append + relecture — 3 entrées, séquences 1..3, prevHash maillé', () => {
  const j = new AuditJournal(jfile);
  j.append('import', { source: 'pennylane-export', invoices: 5 });
  j.append('engine_result', { paymentId: 'p1', decision: 'proposal', residualCents: 9600 });
  j.append('human_decision', { paymentId: 'p1', action: 'validated', by: 'comptable' });
  const es = j.entries();
  assert.equal(es.length, 3);
  assert.deepEqual(es.map((e) => e.seq), [1, 2, 3]);
  assert.equal(es[0].prevHash, 'genesis');
  assert.equal(es[1].prevHash, es[0].hash);
  assert.equal(es[2].prevHash, es[1].hash);
  assert.ok(j.verify().ok);
});

test('store : falsification d\'une entrée écrite — détectée au verify, écriture refusée', () => {
  const j = new AuditJournal(jfile);
  const es = j.entries();
  // falsification sur le disque : changement du résiduel de p1 (comme un retry "arrangé")
  const raw = readFileSync(jfile, 'utf8').split('\n');
  const victim = JSON.parse(raw[1]!) as JournalEntry;
  victim.payload = { ...victim.payload as object, residualCents: 0 };
  raw[1] = JSON.stringify(victim);
  writeFileSync(jfile, raw.join('\n'), 'utf8');

  const j2 = new AuditJournal(jfile);
  const status = j2.verify();
  assert.equal(status.ok, false);
  assert.equal(status.atSeq, 2);
  assert.match(status.reason!, /modifiée après écriture/);
  assert.throws(() => j2.append('engine_result', {}), /chaîne cassée/);
});

test('store : retrait d\'une entrée (réordonnancement) — détecté (séquence et/ou maillage rompus)', () => {
  // restaure une chaîne saine d'abord
  const j0 = new AuditJournal(jfile);
  j0.entries(); j0.verify();
  const es = j0.entries();
  const clean = es.map((e) => JSON.stringify(e)).join('\n') + '\n';
  writeFileSync(jfile, clean, 'utf8');
  // puis retire la 2e ligne (suppression d'un historique)
  const lines = clean.split('\n').filter(Boolean);
  lines.splice(1, 1);
  writeFileSync(jfile, lines.join('\n') + '\n', 'utf8');
  const j = new AuditJournal(jfile);
  const status = j.verify();
  assert.equal(status.ok, false);
  // selon la coupure, le contrôle de séquence (le plus précis) ou celui du maillage
  // se déclenche en premier — l'un ou l'autre prouve la rupture de chaîne
  assert.match(status.reason!, /séquence inattendu|maillage prevHash rompu/);
});

test('store : dernière ligne tronquée par un crash — tolérée (ignorée), chaîne saine', () => {
  // chaîne saine de 2 entrées, puis écriture interrompue (pas de \n final, JSON coupé)
  const j = new AuditJournal(join(dir, 'crash.jsonl'));
  j.append('import', { ok: 1 });
  j.append('engine_result', { ok: 2 });
  const raw = readFileSync(join(dir, 'crash.jsonl'), 'utf8');
  writeFileSync(join(dir, 'crash.jsonl'), raw + '{"seq":3,"at":"2026-11-07T00:00:00Z","kind":"engine_result","payl', 'utf8');
  const j2 = new AuditJournal(join(dir, 'crash.jsonl'));
  assert.equal(j2.entries().length, 2); // la ligne incomplète est ignorée
  assert.ok(j2.verify().ok);
});

test('store : relecture après réouverture — le fichier est la seule vérité', () => {
  const j = new AuditJournal(jfile);
  const before = j.entries().map((e) => e.hash);
  const j2 = new AuditJournal(jfile);
  const after = j2.entries().map((e) => e.hash);
  assert.deepEqual(before, after); // hachages identiques : déterminisme de bout en bout
});

test('store : snapshot atomique — aller-retour, tmp nettoyé, corrompu → null (jamais deviner)', () => {
  const snap = join(dir, 'state.json');
  saveSnapshot(snap, { openInvoices: 14, batch: 'novembre' });
  assert.ok(existsSync(snap));
  assert.deepEqual(loadSnapshot<{ openInvoices: number; batch: string }>(snap), { openInvoices: 14, batch: 'novembre' });
  assert.equal(existsSync(`${snap}.tmp-1-1`), false); // pas de tmp traînant (vérification par convention : le rename l'a déplacé)
  saveSnapshot(snap, { openInvoices: 0 });            // écrase proprement
  assert.deepEqual(loadSnapshot<{ openInvoices: number }>(snap), { openInvoices: 0 });
  writeFileSync(snap, '{pas du json', 'utf8');
  assert.equal(loadSnapshot(snap), null);              // corrompu → null, l'appelant ré-importe
  assert.equal(loadSnapshot(join(dir, 'absent.json')), null);
});
