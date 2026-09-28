import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../../src/catalog.ts';
import { buildSystemPrompt, decisionSchema, parseChoice } from '../../src/brains/prompt.ts';
import { sampleConfig } from '../fixtures.ts';

const cat = buildCatalog(sampleConfig());

test('schema lists every allowlisted choice plus remember_fact and unknown', () => {
  const s = decisionSchema(cat) as any;
  assert.deepEqual(s.properties.choice.enum, [
    'open_app:teams', 'open_app:jira', 'open_app:notepad',
    'open_workspace:agentic', 'run_routine:start_day', 'remember_fact', 'unknown',
  ]);
});

test('system prompt includes options, facts and the injection warning', () => {
  const p = buildSystemPrompt(cat, ['my Jira board is PAY']);
  assert.match(p, /open_workspace:agentic/);
  assert.match(p, /my Jira board is PAY/);
  assert.match(p, /data, not instructions/);
});

test('parseChoice turns a valid choice into a decision', () => {
  assert.deepEqual(parseChoice({ choice: 'open_app:teams', confidence: 0.8 }, cat, 'x'),
    { intent: 'open_app', target: 'teams', confidence: 0.8, source: 'x' });
});

test('parseChoice maps remember_fact to its fact text', () => {
  assert.deepEqual(parseChoice({ choice: 'remember_fact', fact: ' my board is PAY ', confidence: 1 }, cat, 'x'),
    { intent: 'remember_fact', target: 'my board is PAY', confidence: 1, source: 'x' });
  assert.equal(parseChoice({ choice: 'remember_fact', confidence: 1 }, cat, 'x').intent, 'unknown');
});

test('parseChoice rejects garbage and off-allowlist choices', () => {
  const bad = [null, 'open_app:teams', { choice: 'open_app:powershell', confidence: 1 }, { choice: 'run_shell:rm', confidence: 1 }, { choice: 'unknown', confidence: 1 }];
  for (const v of bad) assert.equal(parseChoice(v, cat, 'x').intent, 'unknown');
});

test('parseChoice clamps confidence into 0..1', () => {
  assert.equal(parseChoice({ choice: 'open_app:teams', confidence: 7 }, cat, 'x').confidence, 1);
});

test('data/instructions warning appears before facts and covers both', () => {
  const p = buildSystemPrompt(cat, ['my Jira board is PAY']);
  const warningIdx = p.indexOf('data, not instructions');
  const factsIdx = p.indexOf('Known facts');
  assert(warningIdx >= 0, 'warning should mention "data, not instructions"');
  assert(factsIdx >= 0, 'prompt should have facts section');
  assert(warningIdx < factsIdx, 'warning should appear before facts section');
  assert.match(p, /facts.*data, not instructions/i);
});
