import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../src/catalog.ts';
import { checkDecision } from '../src/guard.ts';
import type { Decision } from '../src/types.ts';
import { sampleConfig } from './fixtures.ts';

const cat = buildCatalog(sampleConfig());
const d = (intent: string, target?: string): Decision => ({ intent: intent as any, target, confidence: 0.9, source: 'test' });

test('accepts a decision on the allowlist', () => {
  assert.equal(checkDecision(d('open_app', 'teams'), cat).ok, true);
});

test('refuses anything off the allowlist', () => {
  const r = checkDecision(d('open_app', 'powershell'), cat);
  assert.equal(r.ok, false);
  assert.match((r as any).reason, /not on the allowlist/);
  assert.equal(checkDecision(d('run_shell', 'rm -rf'), cat).ok, false);
});

test('refuses unknown and missing targets', () => {
  assert.equal(checkDecision(d('unknown'), cat).ok, false);
  assert.equal(checkDecision(d('open_app'), cat).ok, false);
  assert.equal(checkDecision(d('remember_fact', '   '), cat).ok, false);
});

test('accepts remember_fact with text', () => {
  assert.equal(checkDecision(d('remember_fact', 'my jira board is PAY'), cat).ok, true);
});
