import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhrase } from '../src/normalize.ts';

test('lowercases, strips punctuation and collapses spaces', () => {
  assert.equal(normalizePhrase('  Agentic,   DEV!! '), 'agentic dev');
});

test('strips a leading wake word', () => {
  assert.equal(normalizePhrase('Hey Jarvis, start my day'), 'start my day');
  assert.equal(normalizePhrase('jarvis open teams'), 'open teams');
  assert.equal(normalizePhrase('Hey Izza, start my day'), 'start my day');
  assert.equal(normalizePhrase('izza open teams'), 'open teams');
});

test('keeps jarvis when it is not the leading word', () => {
  assert.equal(normalizePhrase('open jarvis project'), 'open jarvis project');
  assert.equal(normalizePhrase('jarvisfoo'), 'jarvisfoo');
});

test('returns an empty string for punctuation only', () => {
  assert.equal(normalizePhrase('?!'), '');
});
