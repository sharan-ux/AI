import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../../src/catalog.ts';
import { buildJevRequest, createJevBrain, parseJevResponse } from '../../src/brains/jev.ts';
import { sampleConfig } from '../fixtures.ts';

const cat = buildCatalog(sampleConfig());
const answer = (choice: string, p: number) => ({
  answers: { action: { type: 'choice', choice, confidence: p, probabilities: { [choice]: p } } },
});

test('builds a choice question over the allowlist', () => {
  const req = buildJevRequest('open teams', cat, ['board is PAY'], 'typesafe/jev-1.13') as any;
  assert.equal(req.model, 'typesafe/jev-1.13');
  assert.equal(req.questions.action.type, 'choice');
  assert.deepEqual(Object.keys(req.questions.action.criteria), [
    'open_app:teams', 'open_app:jira', 'open_app:notepad', 'open_workspace:agentic', 'run_routine:start_day', 'unknown',
  ]);
  assert.match(req.state, /board is PAY/);
  assert.match(req.state, /open teams/);
});

test('accepts a confident allowlisted answer', () => {
  assert.deepEqual(parseJevResponse(answer('open_app:teams', 0.9), cat, 0.75),
    { intent: 'open_app', target: 'teams', confidence: 0.9, source: 'jev' });
});

test('falls through when unsure, unknown, off-list or malformed', () => {
  assert.equal(parseJevResponse(answer('open_app:teams', 0.5), cat, 0.75), null);
  assert.equal(parseJevResponse(answer('unknown', 0.99), cat, 0.75), null);
  assert.equal(parseJevResponse(answer('open_app:powershell', 0.99), cat, 0.75), null);
  assert.equal(parseJevResponse({}, cat, 0.75), null);
});

test('the brain posts to the URL with the key and fails on HTTP errors', async () => {
  const seen: any[] = [];
  const ok = createJevBrain({
    url: 'https://openrouter.ai/api/v1/decisions', model: 'm', apiKey: 'sk-1', threshold: 0.75,
    fetchFn: (async (url: any, init: any) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(answer('open_app:teams', 0.9)), { status: 200 });
    }) as typeof fetch,
  });
  assert.equal((await ok.decide('open teams', cat, []))?.target, 'teams');
  assert.equal(seen[0].url, 'https://openrouter.ai/api/v1/decisions');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer sk-1');

  const bad = createJevBrain({
    url: 'https://example.test', model: 'm', threshold: 0.75,
    fetchFn: (async () => new Response('no', { status: 401 })) as typeof fetch,
  });
  await assert.rejects(bad.decide('open teams', cat, []), /401/);
});

test('does not send Authorization to a non-openrouter host even with an apiKey set', async () => {
  const seen: any[] = [];
  const brain = createJevBrain({
    url: 'http://localhost:8080/decisions', model: 'm', apiKey: 'sk-1', threshold: 0.75,
    fetchFn: (async (url: any, init: any) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(answer('open_app:teams', 0.9)), { status: 200 });
    }) as typeof fetch,
  });
  await brain.decide('open teams', cat, []);
  assert.equal(seen[0].init.headers.Authorization, undefined);
});
