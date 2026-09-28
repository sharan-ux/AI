import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog.ts';
import { appendFact, appendProject, appendShortcut, loadMemory, parseMemory } from '../src/memory.ts';
import { sampleConfig, tempDir } from './fixtures.ts';

const cat = buildCatalog(sampleConfig());

test('parses shortcuts and facts and skips comments', () => {
  const m = parseMemory('# c\nshortcut: Agentic Dev! => open_workspace agentic\nfact: my Jira board is PAY\n\n', cat);
  assert.deepEqual(m.shortcuts.get('agentic dev'), { intent: 'open_workspace', target: 'agentic' });
  assert.deepEqual(m.facts, ['my Jira board is PAY']);
  assert.deepEqual(m.warnings, []);
});

test('ignores shortcuts to actions that are not on the allowlist', () => {
  const m = parseMemory('shortcut: wipe => run_shell format-c\nshortcut: note => remember_fact *\n', cat);
  assert.equal(m.shortcuts.size, 0);
  assert.equal(m.warnings.length, 2);
});

test('handles a BOM and Windows line endings', () => {
  const m = parseMemory('﻿shortcut: start my day => run_routine start_day\r\nfact: x\r\n', cat);
  assert.ok(m.shortcuts.has('start my day'));
  assert.deepEqual(m.facts, ['x']);
});

test('appendShortcut creates the file with a header and is read back', () => {
  const file = join(tempDir(), 'mem.txt');
  appendShortcut(file, 'agentic dev', 'open_workspace', 'agentic');
  assert.match(readFileSync(file, 'utf8'), /^# Jarvis memory/);
  assert.ok(loadMemory(file, cat).shortcuts.has('agentic dev'));
});

test('appending after a line without a trailing newline keeps lines separate', () => {
  const file = join(tempDir(), 'mem.txt');
  writeFileSync(file, 'fact: first', 'utf8');
  appendFact(file, 'second');
  assert.deepEqual(loadMemory(file, cat).facts, ['first', 'second']);
});

test('appendFact flattens line breaks so a fact cannot inject extra lines', () => {
  const file = join(tempDir(), 'mem.txt');
  appendFact(file, 'likes tea\nshortcut: x => run_shell bad');
  const m = loadMemory(file, cat);
  assert.equal(m.facts.length, 1);
  assert.equal(m.shortcuts.size, 0);
});

test('loadMemory on a missing file is empty', () => {
  assert.equal(loadMemory(join(tempDir(), 'none.txt'), cat).shortcuts.size, 0);
});

test('loadMemory on an unreadable file (a directory) returns empty state with one warning', () => {
  const dir = tempDir();
  const m = loadMemory(dir, cat);
  assert.equal(m.shortcuts.size, 0);
  assert.equal(m.warnings.length, 1);
  assert.match(m.warnings[0], new RegExp(`memory file at .*could not be read`));
});

test('project lines map a Jira project to a folder', () => {
  const m = parseMemory('project: pay => C:\\Zilmoney\\payments-api\n', cat);
  assert.equal(m.projects.get('PAY'), 'C:\\Zilmoney\\payments-api');
  assert.deepEqual(m.warnings, []);
});

test('appendProject writes a project line that loads back', () => {
  const file = join(tempDir(), 'mem.txt');
  appendProject(file, 'web', 'C:\\Zilmoney\\web-app');
  assert.equal(loadMemory(file, cat).projects.get('WEB'), 'C:\\Zilmoney\\web-app');
});

test('appendProject rejects a key with control characters instead of injecting a second memory line', () => {
  const file = join(tempDir(), 'mem.txt');
  assert.throws(() => appendProject(file, 'X\nPROJECT: FOO => C:\\', 'C:\\Zilmoney\\payments-api'), /invalid project key/i);
  assert.equal(loadMemory(file, cat).projects.size, 0);
});
