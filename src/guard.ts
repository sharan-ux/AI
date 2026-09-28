import { findEntry } from './catalog.ts';
import type { Catalog, CatalogEntry, Decision } from './types.ts';

export type GuardResult = { ok: true; entry: CatalogEntry } | { ok: false; reason: string };

export function checkDecision(decision: Decision, catalog: Catalog): GuardResult {
  if (decision.intent === 'unknown') return { ok: false, reason: 'unknown request' };
  if (typeof decision.target !== 'string' || decision.target.trim() === '') {
    return { ok: false, reason: `${decision.intent} needs a target` };
  }
  const entry = findEntry(catalog, decision.intent, decision.target);
  if (!entry) return { ok: false, reason: `"${decision.intent} ${decision.target}" is not on the allowlist` };
  return { ok: true, entry };
}
