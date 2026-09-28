import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getTask, loadBoard, saveBoard, upsertTask } from '../../src/agent/board.ts';
import { tempDir } from '../fixtures.ts';

test('missing board is empty; save and load round-trip', () => {
  const file = join(tempDir(), 'data', 'tasks.json');
  const b = loadBoard(file);
  assert.deepEqual(b.tasks, []);
  upsertTask(b, { id: 'PAY-142', title: 'Reject empty amounts', project: 'PAY', status: 'running' });
  saveBoard(file, b);
  const again = loadBoard(file);
  assert.equal(getTask(again, 'PAY-142')?.title, 'Reject empty amounts');
  assert.equal(getTask(again, 'PAY-142')?.rounds, 0);
});

test('upsert merges and stamps updated', () => {
  const b = { tasks: [] };
  upsertTask(b, { id: 'A-1', status: 'running', decisions: ['x'] });
  const t = upsertTask(b, { id: 'A-1', status: 'done' });
  assert.equal(t.status, 'done');
  assert.deepEqual(t.decisions, ['x']);
  assert.match(t.updated, /^\d{4}-/);
  assert.equal(b.tasks.length, 1);
});

test('hand edits with a BOM and extra fields still load', () => {
  const file = join(tempDir(), 'tasks.json');
  writeFileSync(file, '﻿{"tasks":[{"id":"A-1","status":"paused","note":"mine"}]}', 'utf8');
  assert.equal(loadBoard(file).tasks[0].status, 'paused');
});

test('a corrupt board is backed up and reset with a warning', () => {
  const dir = tempDir();
  const file = join(dir, 'tasks.json');
  writeFileSync(file, '{oops', 'utf8');
  const warnings: string[] = [];
  assert.deepEqual(loadBoard(file, (w) => warnings.push(w)).tasks, []);
  assert.equal(warnings.length, 1);
  assert.ok(readdirSync(dir).some((f) => f.startsWith('tasks.json.corrupt-')));
  assert.equal(existsSync(file), false);
});

test('finding 5: two fresh task records do not share a decisions array', () => {
  const b = { tasks: [] };
  const a = upsertTask(b, { id: 'A-1', status: 'running' });
  const c = upsertTask(b, { id: 'A-2', status: 'running' });
  a.decisions.push('x');
  assert.deepEqual(c.decisions, []);
  assert.deepEqual(a.decisions, ['x']);
});
