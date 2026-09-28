import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createWorkerPool, parseStatus } from '../../src/agent/workers.ts';
import type { WorkerEvent } from '../../src/agent/workers.ts';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
const spec = (id: string, mode: string) => ({ id, cwd: process.cwd(), args: [FAKE, `--mode=${mode}`], resumeArgs: [FAKE, `--mode=${mode}`], brief: `do ${id}` });
const waitFor = async (pred: () => boolean, ms = 5000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

function pool(extra: Record<string, unknown> = {}) {
  const events: WorkerEvent[] = [];
  // Default to "plenty of memory" so these tests never depend on how much is actually free on the
  // machine running them (a shared laptop can dip under the real 800 MB floor mid-suite). Tests that
  // care about the low-memory path override freeMemory explicitly.
  const p = createWorkerPool({ exe: process.execPath, freeMemory: () => Number.MAX_SAFE_INTEGER, onEvent: (e) => events.push(e), ...extra });
  return { p, events };
}

test('parseStatus', () => {
  assert.deepEqual(parseStatus('ok\nSTATUS: DONE — added validator'), { kind: 'done', line: 'added validator' });
  assert.equal(parseStatus('STATUS: question - which file').kind, 'question');
  assert.equal(parseStatus('STATUS: BLOCKED — no node').kind, 'blocked');
  assert.equal(parseStatus('just chatting').kind, 'reply');
});

test('a worker runs its brief and reports DONE', async () => {
  const { p, events } = pool();
  assert.equal(p.start(spec('A-1', 'done')), 'running');
  await waitFor(() => events.some((e) => e.kind === 'done'));
  assert.ok(events.some((e) => e.kind === 'progress' && /Bash npm test/.test(e.text)));
  p.stopAll();
});

test('the same ticket cannot run twice', () => {
  const { p } = pool();
  p.start(spec('A-1', 'silent'));
  assert.throws(() => p.start(spec('A-1', 'silent')), /already running/);
  p.stopAll();
});

test('more than maxConcurrent queue, and start when a slot frees', async () => {
  const { p } = pool({ maxConcurrent: 2 });
  p.start(spec('A-1', 'silent')); p.start(spec('A-2', 'silent'));
  assert.equal(p.start(spec('A-3', 'silent')), 'queued');
  p.stop('A-1');
  await waitFor(() => p.status('A-3')[0].state === 'running');
  p.stopAll();
});

test('low memory queues new workers', () => {
  const { p } = pool({ freeMemory: () => 0 });
  assert.equal(p.start(spec('A-1', 'silent')), 'queued');
});

test('a memory-queued worker starts once checkStalls sees memory free up', () => {
  let free = 0;
  const { p } = pool({ freeMemory: () => free });
  assert.equal(p.start(spec('A-1', 'silent')), 'queued');
  assert.equal(p.status('A-1')[0].state, 'queued');
  free = Number.MAX_SAFE_INTEGER;
  p.checkStalls();
  assert.equal(p.status('A-1')[0].state, 'running');
  p.stopAll();
});

test('a crashing worker restarts once, then fails', async () => {
  const { p, events } = pool();
  p.start(spec('A-1', 'crash'));
  await waitFor(() => events.some((e) => e.kind === 'failed'));
  assert.equal(events.filter((e) => e.kind === 'crashed').length, 1);
  assert.equal(p.status('A-1')[0].state, 'failed');
});

test('a silent worker is reported stalled once', () => {
  let t = 0;
  const { p, events } = pool({ now: () => t, stallMs: 1000 });
  p.start(spec('A-1', 'silent'));
  t = 1500; p.checkStalls(); p.checkStalls();
  assert.equal(events.filter((e) => e.kind === 'stalled').length, 1);
  p.stopAll();
});

test('stopAll never starts a queued worker, and leaves no live children', async () => {
  const events: WorkerEvent[] = [];
  const children: ReturnType<typeof spawn>[] = [];
  const spawnFn = (...args: Parameters<typeof spawn>) => {
    const child = spawn(...args);
    children.push(child);
    return child;
  };
  const p = createWorkerPool({ exe: process.execPath, maxConcurrent: 1, freeMemory: () => Number.MAX_SAFE_INTEGER, onEvent: (e) => events.push(e), spawnFn });
  assert.equal(p.start(spec('A-1', 'silent')), 'running');
  assert.equal(p.start(spec('A-2', 'silent')), 'queued');
  p.stopAll();
  await new Promise((r) => setTimeout(r, 300));
  assert.notEqual(p.status('A-2')[0].state, 'running');
  assert.equal(children.length, 1, 'the queued worker must never be spawned once stopAll has run');
  assert.throws(() => p.start(spec('A-3', 'silent')), /stopped/);
  await waitFor(() => children.every((c) => c.exitCode !== null || c.signalCode !== null));
});

test('message only reaches a running worker', async () => {
  const { p, events } = pool();
  p.start(spec('A-1', 'echo'));
  await waitFor(() => events.some((e) => e.kind === 'reply'));
  p.message('A-1', 'use the shared validator');
  await waitFor(() => events.some((e) => /use the shared validator/.test(e.text)));
  assert.throws(() => p.message('B-9', 'x'), /not running/);
  p.stopAll();
});
