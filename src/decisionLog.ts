import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Outcome = 'executed' | 'declined' | 'failed' | 'rejected' | 'unknown';

export interface LogRecord {
  ts: string;
  text: string;
  source: string;
  intent: string;
  target?: string;
  confidence: number;
  outcome: Outcome;
}

export function appendDecision(path: string, record: LogRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf8');
}
