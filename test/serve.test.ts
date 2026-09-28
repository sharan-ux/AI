import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog.ts';
import { createServer } from '../src/serve.ts';
import type { ServeContext } from '../src/serve.ts';
import { preRouteToAgent } from '../src/router.ts';
import type { Brain, Decision } from '../src/types.ts';
import { sampleConfig, tempDir } from './fixtures.ts';

function setup(decisions: (Decision | null)[]) {
  const dir = tempDir();
  const config = sampleConfig();
  const queue = [...decisions];
  const brain: Brain = { name: 'scripted', async decide() { return queue.shift() ?? null; } };
  const base: ServeContext = {
    config, catalog: buildCatalog(config), brains: [brain],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run(e) { return [{ label: e.target, ok: true }]; } },
  };
  const out: any[] = [];
  const server = createServer(base, (m) => out.push(m));
  return { server, out };
}
const dec = (intent: string, target?: string): Decision => ({ intent: intent as any, target, confidence: 0.9, source: 'scripted' });

test('a command produces thinking then done with a spoken reply', async () => {
  const { server, out } = setup([dec('open_app', 'teams')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open teams' }));
  await server.idle();
  assert.deepEqual(out[0], { type: 'state', state: 'thinking' });
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.id, 'c1');
  assert.equal(done.outcome, 'executed');
  assert.equal(done.say, 'Opening Teams.');
  assert.ok(done.lines.some((l: string) => l.includes('✓ teams')));
});

test('ask waits for the matching answer', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  const ask = out.find((m) => m.type === 'ask');
  assert.match(ask.question, /Proceed\?/);
  server.handleLine(JSON.stringify({ type: 'answer', id: ask.id, value: true }));
  await server.idle();
  assert.equal(out.find((m) => m.type === 'done').outcome, 'executed');
});

test('a null answer declines', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  server.handleLine(JSON.stringify({ type: 'answer', id: out.find((m) => m.type === 'ask').id, value: null }));
  await server.idle();
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.outcome, 'declined');
  assert.equal(done.say, 'Okay, cancelled.');
});

test('commands run one at a time and the queue is capped at 3', async () => {
  const { server, out } = setup([dec('open_app', 'notepad'), dec('open_app', 'teams'), dec('open_app', 'teams'), dec('open_app', 'teams')]);
  for (let i = 1; i <= 5; i++) server.handleLine(JSON.stringify({ type: 'command', id: `c${i}`, text: `command ${i}` }));   // distinct texts: no shortcut offer
  await new Promise((r) => setTimeout(r, 20));
  const busy = out.find((m) => m.type === 'done' && m.id === 'c5');
  assert.equal(busy.say, "I'm still working on the last one.");
  assert.equal(out.filter((m) => m.type === 'ask').length, 1);            // c1 is waiting; c2-c4 queued
  server.handleLine(JSON.stringify({ type: 'answer', id: out.find((m) => m.type === 'ask').id, value: false }));
  await server.idle();
  assert.deepEqual(out.filter((m) => m.type === 'done').map((m) => m.id), ['c5', 'c1', 'c2', 'c3', 'c4']);
});

test('bad lines produce warnings, never crashes', async () => {
  const { server, out } = setup([]);
  server.handleLine('not json');
  server.handleLine(JSON.stringify({ type: 'dance' }));
  server.handleLine('');
  assert.equal(out.filter((m) => m.type === 'warning').length, 2);
});

test('close answers pending questions with null so nothing hangs', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  server.close();
  await server.idle();
  assert.equal(out.find((m) => m.type === 'done').outcome, 'declined');
});

test('agent requests go to the manager and come back as done with outcome agent', async () => {
  const dir = tempDir();
  const config = sampleConfig();
  const out: any[] = [];
  const agent = { userTurn: async (t: string) => `manager says: ${t}` };
  const server = createServer({
    config, catalog: buildCatalog(config), brains: [],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run() { return []; } },
  }, (m) => out.push(m), agent);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'look at PAY-142' }));
  await server.idle();
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.outcome, 'agent');
  assert.equal(done.say, 'manager says: look at PAY-142');
});

test('unknown quick commands fall through to the manager', async () => {
  const dir = tempDir();
  const config = sampleConfig();
  const out: any[] = [];
  // "summarize my calendar" is not pre-routed (no ticket shape, no agent words), so this
  // exercises the fall-through path: handleCommand -> outcome 'unknown' -> manager.
  assert.equal(preRouteToAgent('summarize my calendar'), false);
  const server = createServer({
    config, catalog: buildCatalog(config), brains: [],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run() { return []; } },
  }, (m) => out.push(m), { userTurn: async () => 'handled by manager' });
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'summarize my calendar' }));
  await server.idle();
  assert.equal(out.find((m) => m.type === 'done').say, 'handled by manager');
});

test('agent asks accept text and boolean answers', async () => {
  const { server, out } = setup([]);
  const p1 = server.askUser('Which folder?', 'text');
  const a1 = out.find((m) => m.type === 'agent-ask');
  assert.equal(a1.kind, 'text');
  server.handleLine(JSON.stringify({ type: 'answer', id: a1.id, value: 'payments api' }));
  assert.equal(await p1, 'payments api');
  const p2 = server.askUser('Push?', 'confirm');
  const a2 = out.filter((m) => m.type === 'agent-ask')[1];
  server.handleLine(JSON.stringify({ type: 'answer', id: a2.id, value: true }));
  assert.equal(await p2, true);
  server.say('PAY-142 is done.');
  assert.deepEqual(out.at(-1), { type: 'agent-say', text: 'PAY-142 is done.' });
});

test('progress is throttled', () => {
  const { server, out } = setup([]);
  server.progress(); server.progress(); server.progress();
  assert.equal(out.filter((m) => m.type === 'agent-progress').length, 1);
});

test('a pre-routed agent turn does not block a quick command behind it', async () => {
  const dir = tempDir();
  const config = sampleConfig();
  const brain: Brain = { name: 'scripted', async decide() { return dec('open_app', 'teams'); } };
  let releaseAgent!: (v: string) => void;
  const agent = { userTurn: () => new Promise<string>((resolve) => { releaseAgent = resolve; }) };
  const out: any[] = [];
  const server = createServer({
    config, catalog: buildCatalog(config), brains: [brain],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run(e) { return [{ label: e.target, ok: true }]; } },
  }, (m) => out.push(m), agent);
  server.handleLine(JSON.stringify({ type: 'command', id: 'agent1', text: 'look at PAY-142' })); // pre-routed, agent turn pending
  server.handleLine(JSON.stringify({ type: 'command', id: 'quick1', text: 'open teams' })); // quick, local
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(out.filter((m) => m.type === 'done').map((m) => m.id), ['quick1']); // quick command finished first, agent turn still pending
  releaseAgent('manager says hi');
  await server.idle();
  const doneIds = out.filter((m) => m.type === 'done').map((m) => m.id);
  assert.deepEqual(doneIds, ['quick1', 'agent1']);
  assert.equal(out.find((m) => m.type === 'done' && m.id === 'agent1').say, 'manager says hi');
});

test('a fall-through agent turn releases the local lock so the next quick command runs', async () => {
  const dir = tempDir();
  const config = sampleConfig();
  let calls = 0;
  // 1st decide (for the fall-through text) finds nothing -> outcome 'unknown'; 2nd decide (for the quick command) succeeds locally.
  const brain: Brain = { name: 'scripted', async decide() { calls++; return calls === 1 ? null : dec('open_app', 'teams'); } };
  let releaseAgent!: (v: string) => void;
  const agent = { userTurn: () => new Promise<string>((resolve) => { releaseAgent = resolve; }) };
  const out: any[] = [];
  const server = createServer({
    config, catalog: buildCatalog(config), brains: [brain],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run(e) { return [{ label: e.target, ok: true }]; } },
  }, (m) => out.push(m), agent);
  server.handleLine(JSON.stringify({ type: 'command', id: 'fall1', text: 'summarize my calendar' })); // brain returns null -> unknown -> falls through to agent
  server.handleLine(JSON.stringify({ type: 'command', id: 'quick2', text: 'open teams' })); // queued behind fall1; must run once the lock is released, without waiting on the agent
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(out.filter((m) => m.type === 'done').map((m) => m.id), ['quick2']); // ran while fall1's agent turn is still pending
  releaseAgent('handled by manager');
  await server.idle();
  const doneIds = out.filter((m) => m.type === 'done').map((m) => m.id);
  assert.deepEqual(doneIds, ['quick2', 'fall1']);
});

test('a rejecting agent produces a failed done', async () => {
  const dir = tempDir();
  const config = sampleConfig();
  const out: any[] = [];
  const agent = { userTurn: async () => { throw new Error('manager exploded'); } };
  const server = createServer({
    config, catalog: buildCatalog(config), brains: [],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run() { return []; } },
  }, (m) => out.push(m), agent);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'look at PAY-142' }));
  await server.idle();
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.outcome, 'failed');
  assert.equal(done.say, "I couldn't reach my manager brain.");
});
