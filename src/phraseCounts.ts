import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface CountsState {
  counts: Record<string, number>;
  declined: string[];
}

type Warn = (message: string) => void;

export function countKey(phrase: string, intent: string, target: string): string {
  return `${phrase} => ${intent} ${target}`;
}

function load(path: string, warn: Warn): CountsState {
  if (!existsSync(path)) return { counts: {}, declined: [] };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    if (typeof raw?.counts !== 'object' || raw.counts === null || Array.isArray(raw.counts) || !Array.isArray(raw.declined)) {
      throw new Error('bad shape');
    }
    return { counts: raw.counts, declined: raw.declined };
  } catch {
    warn(`phrase counts at ${path} were unreadable - starting fresh`);
    return { counts: {}, declined: [] };
  }
}

function save(path: string, state: CountsState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf8');
}

export function recordUse(path: string, key: string, suggestAfter: number, warn: Warn = console.warn): { count: number; suggest: boolean } {
  const state = load(path, warn);
  const count = (state.counts[key] ?? 0) + 1;
  state.counts[key] = count;
  save(path, state);
  return { count, suggest: count >= suggestAfter && !state.declined.includes(key) };
}

export function markDeclined(path: string, key: string, warn: Warn = console.warn): void {
  const state = load(path, warn);
  if (!state.declined.includes(key)) state.declined.push(key);
  save(path, state);
}
