import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCatalog, findEntry } from '../src/catalog.ts';
import { validateConfig } from '../src/config.ts';
import { createRunner, launchDetached, workspaceCommands } from '../src/actions.ts';
import { rawConfig, sampleConfig, tempDir } from './fixtures.ts';

function fakeLauncher(failures: Record<string, Error> = {}) {
  const calls: { exe: string; args: string[] }[] = [];
  const launch = async (exe: string, args: string[]) => {
    calls.push({ exe, args });
    if (failures[exe]) throw failures[exe];
  };
  return { calls, launch };
}

const enoent = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
const cfg = sampleConfig();
const cat = buildCatalog(cfg);
const entry = (intent: string, target: string) => findEntry(cat, intent, target)!;

test('opens a URL app in Chrome with the configured profile', async () => {
  const f = fakeLauncher();
  const r = await createRunner(cfg, f.launch).run(entry('open_app', 'teams'));
  assert.deepEqual(r, [{ label: 'teams', ok: true }]);
  assert.deepEqual(f.calls, [{ exe: 'C:\\chrome.exe', args: ['--profile-directory=Default', 'https://teams.microsoft.com/'] }]);
});

test('launches an exe app directly', async () => {
  const f = fakeLauncher();
  await createRunner(cfg, f.launch).run(entry('open_app', 'notepad'));
  assert.deepEqual(f.calls, [{ exe: 'notepad.exe', args: [] }]);
});

test('an app with no URL is reported and nothing launches', async () => {
  const f = fakeLauncher();
  const [r] = await createRunner(cfg, f.launch).run(entry('open_app', 'jira'));
  assert.equal(r.ok, false);
  assert.match(r.message!, /apps\.jira\.url/);
  assert.equal(f.calls.length, 0);
});

test('a workspace opens VS Code and a terminal resuming the Claude session', async () => {
  const f = fakeLauncher();
  await createRunner(cfg, f.launch).run(entry('open_workspace', 'agentic'));
  assert.deepEqual(f.calls, [
    { exe: 'C:\\Local\\Code.exe', args: ['C:\\Zilmoney\\Agentic'] },
    { exe: 'C:\\wt.exe', args: ['-d', 'C:\\Zilmoney\\Agentic', 'C:\\claude.exe', '--resume', 'abc-123'] },
  ]);
});

test('continue mode uses --continue and none mode skips the terminal', () => {
  const raw = rawConfig();
  raw.workspaces.agentic.claude = { mode: 'continue' };
  assert.deepEqual(workspaceCommands(validateConfig(raw, {}), 'agentic')[1].args.slice(-1), ['--continue']);
  raw.workspaces.agentic.claude = { mode: 'none' };
  assert.equal(workspaceCommands(validateConfig(raw, {}), 'agentic').length, 1);
});

test('a missing program is explained and the routine keeps going', async () => {
  const f = fakeLauncher({ 'C:\\Local\\Code.exe': enoent });
  const r = await createRunner(cfg, f.launch).run(entry('run_routine', 'start_day'));
  assert.deepEqual(r.map((x) => x.ok), [true, false, false]);
  assert.match(r[2].message!, /VS Code not found at C:\\Local\\Code\.exe/);
  assert.ok(f.calls.some((c) => c.exe === 'C:\\wt.exe'), 'terminal still launched');
});

test('launchDetached rejects with ENOENT for nonexistent exe', async () => {
  const nonexistentPath = join(tempDir(), 'does-not-exist.exe');
  await assert.rejects(launchDetached(nonexistentPath, []), (e: any) => e.code === 'ENOENT');
});
