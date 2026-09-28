import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCatalog } from '../../src/catalog.ts';
import { decide } from '../../src/brainChain.ts';
import { createShortcutBrain } from '../../src/brains/shortcut.ts';
import { buildBrains } from '../../src/brains/index.ts';
import { loadEnv } from '../../src/env.ts';
import type { Brain, Decision } from '../../src/types.ts';
import { sampleConfig, tempDir } from '../fixtures.ts';

const cat = buildCatalog(sampleConfig());
const fixed = (name: string, result: Decision | null | Error): Brain => ({
  name,
  async decide() {
    if (result instanceof Error) throw result;
    return result;
  },
});

test('first brain with a decision wins', async () => {
  const d: Decision = { intent: 'open_app', target: 'teams', confidence: 1, source: 'b' };
  const r = await decide('x', [fixed('a', null), fixed('b', d), fixed('c', { ...d, target: 'jira' })], cat, []);
  assert.equal(r.decision.target, 'teams');
});

test('errors fall through and are reported when nothing decides', async () => {
  const r = await decide('x', [fixed('a', new Error('boom')), fixed('b', null)], cat, []);
  assert.equal(r.decision.intent, 'unknown');
  assert.deepEqual(r.errors, ['a: boom']);
});

test('shortcut brain matches normalized phrases', async () => {
  const b = createShortcutBrain(() => new Map([['agentic dev', { intent: 'open_workspace' as const, target: 'agentic' }]]));
  assert.equal((await b.decide('Jarvis, Agentic Dev!', cat, []))?.source, 'shortcut');
  assert.equal(await b.decide('something else', cat, []), null);
});

const memPath = () => join(tempDir(), 'm.txt');

test('buildBrains: Claude Code only by default', () => {
  const r = buildBrains(loadEnv({}), sampleConfig(), cat, memPath());
  assert.deepEqual(r.brains.map((b) => b.name), ['shortcut', 'claude-code']);
  assert.deepEqual(r.warnings, []);
});

test('buildBrains: Jev switch without a key stays off with a warning', () => {
  const r = buildBrains(loadEnv({ JEV_ENABLED: 'true' }), sampleConfig(), cat, memPath());
  assert.deepEqual(r.brains.map((b) => b.name), ['shortcut', 'claude-code']);
  assert.match(r.warnings[0], /OPENROUTER_API_KEY/);
});

test('buildBrains: Jev with a key goes before Claude Code', () => {
  const r = buildBrains(loadEnv({ JEV_ENABLED: 'true', OPENROUTER_API_KEY: 'sk' }), sampleConfig(), cat, memPath());
  assert.deepEqual(r.brains.map((b) => b.name), ['shortcut', 'jev', 'claude-code']);
});

test('buildBrains: a local Laya URL needs no key', () => {
  const r = buildBrains(loadEnv({ JEV_ENABLED: 'true', JEV_URL: 'http://localhost:8000/v1/systemone' }), sampleConfig(), cat, memPath());
  assert.deepEqual(r.brains.map((b) => b.name), ['shortcut', 'jev', 'claude-code']);
});

test('buildBrains: OpenRouter LLM needs both key and model', () => {
  const missing = buildBrains(loadEnv({ OPENROUTER_LLM_ENABLED: 'true', OPENROUTER_API_KEY: 'sk' }), sampleConfig(), cat, memPath());
  assert.deepEqual(missing.brains.map((b) => b.name), ['shortcut', 'claude-code']);
  assert.match(missing.warnings[0], /OPENROUTER_MODEL/);
  const on = buildBrains(loadEnv({ OPENROUTER_LLM_ENABLED: 'true', OPENROUTER_API_KEY: 'sk', OPENROUTER_MODEL: 'x/y' }), sampleConfig(), cat, memPath());
  assert.deepEqual(on.brains.map((b) => b.name), ['shortcut', 'openrouter', 'claude-code']);
});
