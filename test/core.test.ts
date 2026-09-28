import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog.ts';
import { handleCommand } from '../src/core.ts';
import type { CoreContext } from '../src/core.ts';
import { loadMemory } from '../src/memory.ts';
import { createShortcutBrain } from '../src/brains/shortcut.ts';
import type { StepResult } from '../src/actions.ts';
import type { Brain, Decision } from '../src/types.ts';
import { sampleConfig, tempDir } from './fixtures.ts';

function setup(decisions: (Decision | null)[], opts: { answers?: (boolean | null)[]; results?: StepResult[] } = {}) {
  const dir = tempDir();
  const config = sampleConfig();
  const catalog = buildCatalog(config);
  const paths = { memory: join(dir, 'mem.txt'), counts: join(dir, 'data', 'counts.json'), log: join(dir, 'data', 'log.jsonl') };
  const queue = [...decisions];
  const scripted: Brain = { name: 'scripted', async decide() { return queue.shift() ?? null; } };
  const ran: string[] = [];
  const printed: string[] = [];
  const asked: string[] = [];
  const answers = [...(opts.answers ?? [])];
  const ctx: CoreContext = {
    config,
    catalog,
    brains: [createShortcutBrain(() => loadMemory(paths.memory, catalog).shortcuts), scripted],
    paths,
    runner: {
      async run(e) {
        ran.push(`${e.intent}:${e.target}`);
        return opts.results ?? [{ label: e.target, ok: true }];
      },
    },
    ask: async (q) => {
      asked.push(q);
      return answers.length > 0 ? answers.shift()! : null;
    },
    print: (line) => { printed.push(line); },
  };
  const log = () => (existsSync(paths.log) ? readFileSync(paths.log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { ctx, ran, printed, asked, paths, log };
}

const dec = (intent: string, target?: string): Decision => ({ intent: intent as any, target, confidence: 0.9, source: 'scripted' });

test('runs an allowlisted decision and logs it', async () => {
  const s = setup([dec('open_app', 'teams')]);
  await handleCommand('open teams please', s.ctx);
  assert.deepEqual(s.ran, ['open_app:teams']);
  assert.equal(s.log()[0].outcome, 'executed');
  assert.ok(s.printed.some((l) => l.includes('✓ teams')));
});

test('refuses an off-allowlist decision without running anything', async () => {
  const s = setup([dec('open_app', 'powershell')]);
  await handleCommand('open powershell', s.ctx);
  assert.deepEqual(s.ran, []);
  assert.equal(s.log()[0].outcome, 'rejected');
  assert.ok(s.printed.some((l) => l.includes('Refused')));
});

test('asks before a confirm action and respects no', async () => {
  const s = setup([dec('open_app', 'notepad')], { answers: [false] });
  await handleCommand('open notepad', s.ctx);
  assert.equal(s.asked.length, 1);
  assert.deepEqual(s.ran, []);
  assert.equal(s.log()[0].outcome, 'declined');
});

test('remembers a fact after confirmation', async () => {
  const s = setup([dec('remember_fact', 'my Jira board is PAY')], { answers: [true] });
  await handleCommand('remember my jira board is PAY', s.ctx);
  assert.deepEqual(loadMemory(s.paths.memory, s.ctx.catalog).facts, ['my Jira board is PAY']);
  assert.deepEqual(s.ran, []);
});

test('offers a shortcut on the 3rd use and then uses it without the brain', async () => {
  const s = setup([dec('open_workspace', 'agentic'), dec('open_workspace', 'agentic'), dec('open_workspace', 'agentic')], { answers: [true] });
  for (let i = 0; i < 3; i++) await handleCommand('Agentic dev', s.ctx);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0], /"agentic dev" 3 times/);
  await handleCommand('agentic dev', s.ctx);
  assert.equal(s.log()[3].source, 'shortcut');
  assert.equal(s.ran.length, 4);
  assert.equal(s.asked.length, 1);
});

test('a declined shortcut is not offered again', async () => {
  const s = setup(Array(4).fill(dec('open_app', 'teams')), { answers: [false] });
  for (let i = 0; i < 4; i++) await handleCommand('teams', s.ctx);
  assert.equal(s.asked.length, 1);
});

test('a null answer to the shortcut offer does not decline it, so it is asked again on the 4th use', async () => {
  const s = setup(Array(4).fill(dec('open_app', 'teams')), { answers: [null] });
  for (let i = 0; i < 4; i++) await handleCommand('teams', s.ctx);
  assert.equal(s.asked.length, 2);
  assert.ok(s.printed.every((l) => !l.includes("won't ask about that again")));
});

test('a null answer to a confirm cancels the action', async () => {
  const s = setup([dec('open_app', 'notepad')], { answers: [null] });
  await handleCommand('open notepad', s.ctx);
  assert.deepEqual(s.ran, []);
  assert.equal(s.log()[0].outcome, 'declined');
  assert.ok(s.printed.some((l) => l.includes('Cancelled')));
});

test('a confirmed confirm-flagged action runs and logs executed', async () => {
  const s = setup([dec('open_app', 'notepad')], { answers: [true] });
  await handleCommand('open notepad', s.ctx);
  assert.deepEqual(s.ran, ['open_app:notepad']);
  assert.equal(s.log()[0].outcome, 'executed');
});

test('a routine that partly fails is logged as failed but still counts toward a shortcut', async () => {
  const s = setup([dec('run_routine', 'start_day')], { results: [{ label: 'teams', ok: true }, { label: 'jira', ok: false, message: 'no URL' }] });
  await handleCommand('start my day', s.ctx);
  assert.equal(s.log()[0].outcome, 'failed');
  assert.ok(s.printed.some((l) => l.includes('✗ jira: no URL')));
  assert.ok(existsSync(s.paths.counts));
});

test('when no brain decides, it says so and shows brain errors', async () => {
  const s = setup([]);
  s.ctx.brains.push({ name: 'broken', async decide() { throw new Error('claude not logged in'); } });
  await handleCommand('do a barrel roll', s.ctx);
  assert.ok(s.printed.some((l) => l.includes("don't know")));
  assert.ok(s.printed.some((l) => l.includes('claude not logged in')));
  assert.equal(s.log()[0].outcome, 'unknown');
});

test('a brain that throws "claude output was not JSON" surfaces as unknown with the error printed', async () => {
  const s = setup([]);
  s.ctx.brains.push({
    name: 'claude-code',
    async decide() { throw new Error('claude output was not JSON: Error: something'); },
  });
  await handleCommand('do a barrel roll', s.ctx);
  assert.ok(s.printed.some((l) => l.includes("don't know")));
  assert.ok(s.printed.some((l) => l.includes('claude output was not JSON: Error: something')));
  assert.equal(s.log()[0].outcome, 'unknown');
});

test('blank input does nothing', async () => {
  const s = setup([dec('open_app', 'teams')]);
  await handleCommand('   ', s.ctx);
  assert.deepEqual(s.ran, []);
  assert.deepEqual(s.log(), []);
});

test('handleCommand returns a summary of what happened', async () => {
  const s = setup([dec('open_app', 'teams')]);
  const summary = await handleCommand('open teams', s.ctx);
  assert.equal(summary.outcome, 'executed');
  assert.equal(summary.decision.target, 'teams');
  assert.deepEqual(summary.results, [{ label: 'teams', ok: true }]);
  assert.deepEqual(summary.errors, []);
});

test('blank input returns outcome none', async () => {
  const s = setup([]);
  assert.equal((await handleCommand('  ', s.ctx)).outcome, 'none');
});

test('unknown summary carries brain errors', async () => {
  const s = setup([]);
  s.ctx.brains.push({ name: 'broken', async decide() { throw new Error('nope'); } });
  const summary = await handleCommand('do a flip', s.ctx);
  assert.equal(summary.outcome, 'unknown');
  assert.deepEqual(summary.errors, ['broken: nope']);
});
