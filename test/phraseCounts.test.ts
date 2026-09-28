import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { countKey, markDeclined, recordUse } from '../src/phraseCounts.ts';
import { tempDir } from './fixtures.ts';

test('suggests on the 3rd use, not before', () => {
  const file = join(tempDir(), 'data', 'counts.json');
  const key = countKey('agentic dev', 'open_workspace', 'agentic');
  assert.deepEqual(recordUse(file, key, 3), { count: 1, suggest: false });
  assert.deepEqual(recordUse(file, key, 3), { count: 2, suggest: false });
  assert.deepEqual(recordUse(file, key, 3), { count: 3, suggest: true });
});

test('never suggests a declined phrase again', () => {
  const file = join(tempDir(), 'counts.json');
  const key = countKey('x', 'open_app', 'teams');
  for (let i = 0; i < 3; i++) recordUse(file, key, 3);
  markDeclined(file, key);
  assert.equal(recordUse(file, key, 3).suggest, false);
});

test('a corrupt counts file is reset with a warning', () => {
  const file = join(tempDir(), 'counts.json');
  writeFileSync(file, '{broken', 'utf8');
  const warnings: string[] = [];
  assert.deepEqual(recordUse(file, 'k', 3, (w) => warnings.push(w)), { count: 1, suggest: false });
  assert.equal(warnings.length, 1);
});

test('rejects counts field as array (typeof object but wrong shape)', () => {
  const file = join(tempDir(), 'counts-array.json');
  writeFileSync(file, '{"counts":[],"declined":[]}', 'utf8');
  const warnings: string[] = [];
  assert.deepEqual(recordUse(file, 'k', 3, (w) => warnings.push(w)), { count: 1, suggest: false });
  assert.equal(warnings.length, 1);
  // Verify the file now has the corrected structure
  const m = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(m.counts.k, 1);
});
