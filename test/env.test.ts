import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/env.ts';

test('defaults keep Jev and OpenRouter off', () => {
  const e = loadEnv({});
  assert.equal(e.jevEnabled, false);
  assert.equal(e.llmEnabled, false);
  assert.equal(e.jevUrl, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(e.jevModel, 'typesafe/jev-1.13');
  assert.equal(e.jevThreshold, 0.75);
  assert.equal(e.claudeModel, 'haiku');
  assert.equal(e.openrouterKey, undefined);
});

test('reads switches and values', () => {
  const e = loadEnv({ JEV_ENABLED: 'TRUE', OPENROUTER_API_KEY: ' sk-1 ', JEV_THRESHOLD: '0.9', CLAUDE_BRAIN_MODEL: 'sonnet' });
  assert.equal(e.jevEnabled, true);
  assert.equal(e.openrouterKey, 'sk-1');
  assert.equal(e.jevThreshold, 0.9);
  assert.equal(e.claudeModel, 'sonnet');
});

test('an invalid threshold falls back to 0.75', () => {
  assert.equal(loadEnv({ JEV_THRESHOLD: 'high' }).jevThreshold, 0.75);
  assert.equal(loadEnv({ JEV_THRESHOLD: '5' }).jevThreshold, 0.75);
});
