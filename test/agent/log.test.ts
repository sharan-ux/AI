import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendAgentLog, summarizeInput } from '../../src/agent/log.ts';
import { tempDir } from '../fixtures.ts';

test('log lines are JSON with a timestamp', () => {
  const file = join(tempDir(), 'data', 'agent-log.jsonl');
  appendAgentLog(file, { actor: 'worker:A-1', tool: 'Bash', summary: 'npm test', decision: 'allow', result: 'ok' });
  const rec = JSON.parse(readFileSync(file, 'utf8').trim());
  assert.equal(rec.decision, 'allow');
  assert.match(rec.ts, /^\d{4}-/);
});

test('summaries mask secret-looking keys and stay short', () => {
  const s = summarizeInput({ command: 'x'.repeat(500), apiToken: 'abc123', password: 'p' });
  assert.ok(s.length <= 240);
  assert.doesNotMatch(s, /abc123/);
  assert.doesNotMatch(s, /"p"/);
});

test('finding 4: secrets inline in a command value are redacted, not just by key name', () => {
  const s = summarizeInput({ command: 'curl -d "token=sk-super-secret-abc123" https://x' });
  assert.doesNotMatch(s, /sk-super-secret-abc123/);
  assert.doesNotMatch(s, /abc123/);
  assert.match(s, /token=/);
});

test('finding 4: standalone secret-shaped tokens are redacted even without a key', () => {
  const s = summarizeInput({ command: 'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP' });
  assert.doesNotMatch(s, /AKIAABCDEFGHIJKLMNOP/);
  const s2 = summarizeInput({ command: 'curl -H "Authorization: Bearer sometoken123456" https://x' });
  assert.doesNotMatch(s2, /sometoken123456/);
});
