import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Same technique as reloadPolicy.test.js: main.js imports 'electron' so it can't be `import`-ed
// directly by the plain `node --test` runner. speechCallTimeoutMs() has no Electron dependency,
// so pull its exact source text out of main.js and evaluate it in isolation.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN_JS = path.join(HERE, '..', 'main', 'main.js');
const src = readFileSync(MAIN_JS, 'utf8');
const match = src.match(/export function speechCallTimeoutMs\([\s\S]*?\n\}/);
assert.ok(match, 'speechCallTimeoutMs() not found in app/main/main.js — did the source change shape?');
const speechCallTimeoutMs = new Function(`'use strict'; return (${match[0].replace('export function speechCallTimeoutMs', 'function speechCallTimeoutMs')});`)();

test('transcribe gets a 30s timeout', () => {
  assert.equal(speechCallTimeoutMs('transcribe'), 30000);
});

test('speak gets a 20s timeout', () => {
  assert.equal(speechCallTimeoutMs('speak'), 20000);
});
