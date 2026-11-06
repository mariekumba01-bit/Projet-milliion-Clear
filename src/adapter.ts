// ─────────────────────────────────────────────────────────────────────────────
// Chargeur de moteur — le benchmark est engine-agnostique.
// Brancher le vrai moteur ClearMatch : changer "engine" dans benchmark.config.json.
// Le module doit exporter createEngine(config) → { process(payment, openInvoices, context) }.
// ─────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from 'node:url';
import type { Engine, EngineConfig } from './types.ts';

export async function loadEngine(enginePath: string, config: EngineConfig): Promise<Engine> {
  const mod: any = await import(pathToFileURL(enginePath).href);
  const factory = mod.createEngine ?? mod.default?.createEngine ?? mod.default;
  if (typeof factory !== 'function') {
    throw new Error(`${enginePath} doit exporter createEngine(config) (export nommé, default, ou default.createEngine)`);
  }
  const engine = factory(config);
  if (!engine || typeof engine.process !== 'function') {
    throw new Error(`${enginePath} : createEngine(config) doit retourner { process(payment, openInvoices, context) }`);
  }
  return engine as Engine;
}
