import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, entryKey, findEntry } from '../src/catalog.ts';
import { sampleConfig } from './fixtures.ts';

test('builds one entry per app, workspace and routine plus remember_fact', () => {
  const cat = buildCatalog(sampleConfig());
  assert.deepEqual(cat.entries.map((e) => entryKey(e.intent, e.target)), [
    'open_app:teams', 'open_app:jira', 'open_app:notepad',
    'open_workspace:agentic', 'run_routine:start_day', 'remember_fact:*',
  ]);
  assert.equal(findEntry(cat, 'open_app', 'notepad')?.confirm, true);
  assert.equal(findEntry(cat, 'remember_fact', 'anything at all')?.intent, 'remember_fact');
  assert.equal(findEntry(cat, 'open_app', 'powershell'), undefined);
});
