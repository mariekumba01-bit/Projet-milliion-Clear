// ─────────────────────────────────────────────────────────────────────────────
// ClearMatch Store v0.2.1 — persistance FICHIER, zéro dépendance, zéro base de données.
//
// Réponse à la question « avons-nous besoin d'une base type Supabase ? » : NON pour
// toute la vie du produit en pilote, et voici la preuve exécutable. Le moteur est pur
// et déterministe ; son état se réduit à deux fichiers :
//
//   1. le JOURNAL D'AUDIT — chaîne de hachage append-only (JSONL). Chaque entrée
//      (résultat moteur, décision humaine, import) scelle le hachage de la précédente :
//      toute modification rétroactive d'une ligne casse la chaîne et est DÉTECTÉE au
//      prochain chargement. C'est la propriété exacte qu'on demande à une base pour
//      l'audit — obtenue avec 200 lignes de Node pur.
//   2. le SNAPSHOT — état sérialisable (factures/paiements importés), écriture
//      atomique (tmp + rename) : un crash au milieu d'une écriture ne corrompt jamais
//      le snapshot précédent.
//
// Limites assumées et documentées (le jour où elles mordent, on migre) :
//   • un seul processus écrivain à la fois (un pilote = un poste) ;
//   • pas d'index : la lecture est linéaire — mesurée sans douleur jusqu'à des dizaines
//     de milliers d'entrées, la taille réelle d'un pilote ;
//   • la concurrence multi-tenant est le moment de parler de SQLite (toujours sans
//     serveur), puis d'une base managée — pas avant.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// ── JSON canonique (clés triées) : même objet → même hachage, toujours ─────────
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// ── Journal d'audit chaîné ─────────────────────────────────────────────────────
export interface JournalEntry<T = unknown> {
  seq: number;
  at: string;       // ISO — horodatage d'écriture
  kind: string;     // 'engine_result' | 'human_decision' | 'import' | ...
  payload: T;
  prevHash: string; // hachage de l'entrée précédente ('genesis' pour la première)
  hash: string;     // sha256 du canonique de l'entrée complète
}

export interface JournalStatus {
  ok: boolean;
  count: number;
  reason?: string;  // présent si ok = false
  atSeq?: number;   // entrée où la chaîne est cassée
}

export class AuditJournal<T = unknown> {
  private file: string;
  private cache: JournalEntry<T>[] | null = null;

  constructor(file: string) {
    this.file = file;
  }

  /** Ajoute une entrée ; retourne l'entrée scellée. Aucune écriture si la chaîne d'entrée est déjà cassée. */
  append(kind: string, payload: T, at: string = new Date().toISOString()): JournalEntry<T> {
    const entries = this.entries();
    const last = entries[entries.length - 1];
    const status = this.verify();
    if (!status.ok) {
      throw new Error(`journal corrompu (entrée ${status.atSeq} : ${status.reason}) — refus d'écrire par-dessus une chaîne cassée`);
    }
    const entry: JournalEntry<T> = {
      seq: entries.length + 1,
      at,
      kind,
      payload,
      prevHash: last ? last.hash : 'genesis',
      hash: '',
    };
    entry.hash = sha256(canonical({ ...entry, hash: '' }));
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    this.cache = null; // rechargera depuis le disque : le fichier reste la seule vérité
    return entry;
  }

  /** Toutes les entrées, dans l'ordre. Tolère une dernière ligne tronquée par un crash (lignée incomplète, sans \n final). */
  entries(): JournalEntry<T>[] {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) return (this.cache = []);
    const raw = readFileSync(this.file, 'utf8');
    const lines = raw.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] !== '') {
      // dernière ligne sans saut de final : écriture interrompue — on l'ignore
      lines.pop();
    }
    const out: JournalEntry<T>[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as JournalEntry<T>);
      } catch {
        // ligne illisible (corruption secteur) : la chaîne sera signalée par verify()
        out.push({ seq: -1, at: '', kind: '__unreadable__', payload: null as T, prevHash: '', hash: '' });
      }
    }
    return (this.cache = out);
  }

  /** Vérifie toute la chaîne : hachages recalculés + maillage prevHash. Détecte toute rétro-modification. */
  verify(): JournalStatus {
    const entries = this.entries();
    let prev = 'genesis';
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.seq !== i + 1) return { ok: false, count: entries.length, atSeq: e.seq === -1 ? i + 1 : e.seq, reason: `numéro de séquence inattendu (attendu ${i + 1}, lu ${e.seq})` };
      if (e.prevHash !== prev) return { ok: false, count: entries.length, atSeq: e.seq, reason: 'maillage prevHash rompu — des entrées ont été retirées ou réordonnées' };
      const recomputed = sha256(canonical({ seq: e.seq, at: e.at, kind: e.kind, payload: e.payload, prevHash: e.prevHash, hash: '' }));
      if (recomputed !== e.hash) return { ok: false, count: entries.length, atSeq: e.seq, reason: 'hachage recalculé ≠ hachage stocké — entrée modifiée après écriture' };
      prev = e.hash;
    }
    return { ok: true, count: entries.length };
  }

  /** Export pour rapport d'audit : entrées + statut de la chaîne. */
  exportAudit(): { status: JournalStatus; entries: JournalEntry<T>[] } {
    return { status: this.verify(), entries: this.entries() };
  }
}

// ── Snapshots atomiques ───────────────────────────────────────────────────────
/** Écriture atomique : tmp + rename. Un crash ne corrompt jamais le snapshot précédent. */
export function saveSnapshot<T>(file: string, data: T): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, file);
}

export function loadSnapshot<T>(file: string): T | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch {
    return null; // snapshot illisible : l'appelant décide (re-importer plutôt que deviner)
  }
}
