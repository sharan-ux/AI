import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AgentLogEntry { actor: string; tool: string; summary: string; decision: string; result: string }

// Standalone secret-shaped tokens, redacted wherever they appear (checked first so a later
// key=value pass does not miss a value whose "key" is itself part of the pattern, e.g. Bearer).
const STANDALONE_SECRET = /sk-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|Bearer\s+\S+/g;
// key=value / key: value pairs where the key looks like a credential; keeps the key, masks the value.
const KEY_VALUE_SECRET = /(token|secret|password|passwd|pwd|api[_-]?key|authorization|bearer)(\s*[=:]\s*)([^\s"'&]+)/gi;

export function summarizeInput(input: unknown): string {
  const text = JSON.stringify(input, (k, v) => (/token|secret|password|key|credential/i.test(k) ? '***' : v)) ?? '';
  const redacted = text
    .replace(STANDALONE_SECRET, '***')
    .replace(KEY_VALUE_SECRET, (_m, key, sep) => `${key}${sep}***`);
  return redacted.length > 240 ? `${redacted.slice(0, 237)}...` : redacted;
}

export function appendAgentLog(path: string, entry: AgentLogEntry): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`, 'utf8');
}
