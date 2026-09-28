import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// app/main/main.js imports 'electron', which is not a real module outside the Electron binary
// (it resolves to a path string), so it cannot be `import`-ed by the plain `node --test` runner.
// decideReload() itself has no Electron dependency, so we pull its exact source text straight
// out of main.js (no duplication) and evaluate it in isolation, the same way this repo's other
// fix-round verification worked.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(HERE, '..', 'main', 'main.js');
const src = readFileSync(MAIN_JS, 'utf8');
const match = src.match(/export function decideReload\([\s\S]*?\n\}/);
assert.ok(match, 'decideReload() not found in app/main/main.js — did the source change shape?');
const decideReload = new Function(`'use strict'; return (${match[0].replace('export function decideReload', 'function decideReload')});`)();

test('reloads when there is no recent crash history', () => {
  const result = decideReload([], 1000);
  assert.equal(result.reload, true);
  assert.deepEqual(result.timestamps, [1000]);
});

test('keeps reloading up to the cap within the window', () => {
  let timestamps = [];
  let now = 0;
  for (let i = 0; i < 3; i++) {
    const result = decideReload(timestamps, now);
    assert.equal(result.reload, true, `reload ${i + 1} should be allowed`);
    timestamps = result.timestamps;
    now += 1000;
  }
  assert.equal(timestamps.length, 3);
});

test('refuses to reload once the cap (3 within 60s) is hit', () => {
  const now = 10000;
  const timestamps = [now - 3000, now - 2000, now - 1000]; // 3 crashes already inside the window
  const result = decideReload(timestamps, now);
  assert.equal(result.reload, false);
  assert.deepEqual(result.timestamps, timestamps);
});

test('old crashes outside the 60s window are pruned and do not count against the cap', () => {
  const now = 100000;
  const timestamps = [now - 61000, now - 62000, now - 63000]; // all older than 60s
  const result = decideReload(timestamps, now);
  assert.equal(result.reload, true);
  assert.deepEqual(result.timestamps, [now]); // stale entries dropped, only the fresh one kept
});

test('a mix of stale and fresh crashes only counts the fresh ones toward the cap', () => {
  const now = 100000;
  const timestamps = [now - 61000, now - 30000, now - 10000]; // 1 stale, 2 fresh
  const result = decideReload(timestamps, now);
  assert.equal(result.reload, true); // only 2 fresh crashes so far, cap is 3
  assert.deepEqual(result.timestamps, [now - 30000, now - 10000, now]);
});

test('respects custom maxReloads/windowMs options', () => {
  const now = 5000;
  const timestamps = [now - 100, now - 200];
  const result = decideReload(timestamps, now, { maxReloads: 2, windowMs: 500 });
  assert.equal(result.reload, false);
});
