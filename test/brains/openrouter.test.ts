import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog } from '../../src/catalog.ts';
import { createOpenRouterBrain } from '../../src/brains/openrouter.ts';
import { sampleConfig } from '../fixtures.ts';

const cat = buildCatalog(sampleConfig());
const reply = (content: string) =>
  (async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })) as typeof fetch;

test('turns a chat completion into a decision', async () => {
  const brain = createOpenRouterBrain({ apiKey: 'sk', model: 'm', fetchFn: reply('{"choice":"open_app:teams","confidence":0.8}') });
  assert.equal((await brain.decide('open teams', cat, []))?.target, 'teams');
});

test('returns null for unknown so Claude Code can try', async () => {
  const brain = createOpenRouterBrain({ apiKey: 'sk', model: 'm', fetchFn: reply('{"choice":"unknown","confidence":0.8}') });
  assert.equal(await brain.decide('sing a song', cat, []), null);
});
