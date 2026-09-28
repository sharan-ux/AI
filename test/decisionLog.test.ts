import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendDecision } from '../src/decisionLog.ts';
import type { LogRecord } from '../src/decisionLog.ts';
import { tempDir } from './fixtures.ts';

test('appends one JSON object per line and creates the folder', () => {
  const file = join(tempDir(), 'data', 'log.jsonl');
  const rec: LogRecord = {
    ts: '2026-09-27T00:00:00.000Z', text: 'open teams', source: 'claude-code',
    intent: 'open_app', target: 'teams', confidence: 0.9, outcome: 'executed',
  };
  appendDecision(file, rec);
  appendDecision(file, { ...rec, outcome: 'declined' });
  const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[1].outcome, 'declined');
});
