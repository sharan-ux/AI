import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateConfig, loadConfig, expandEnv } from '../src/config.ts';
import { rawConfig, sampleConfig, tempDir } from './fixtures.ts';

test('expandEnv replaces %VARS% and leaves unknown ones', () => {
  assert.equal(expandEnv('%A%\\x\\%NOPE%', { A: 'C:\\a' }), 'C:\\a\\x\\%NOPE%');
});

test('validates the sample config and expands paths', () => {
  const c = sampleConfig();
  assert.equal(c.vscode.path, 'C:\\Local\\Code.exe');
  assert.equal(c.apps.jira.url, undefined);
  assert.equal(c.apps.notepad.confirm, true);
  assert.equal(c.apps.teams.confirm, false);
  assert.deepEqual(c.workspaces.agentic.claude, { mode: 'resume', sessionId: 'abc-123' });
});

test('rejects a routine step that points at an unknown app', () => {
  const raw = rawConfig();
  raw.routines.start_day.steps.push('app:slack');
  assert.throws(() => validateConfig(raw, {}), /unknown app/);
});

test('rejects resume mode without a session id', () => {
  const raw = rawConfig();
  delete raw.workspaces.agentic.claude.sessionId;
  assert.throws(() => validateConfig(raw, {}), /sessionId/);
});

test('rejects keys with capitals or spaces', () => {
  const raw = rawConfig();
  raw.apps['My App'] = { description: 'x', url: 'https://x' };
  assert.throws(() => validateConfig(raw, {}), /lowercase/);
});

test('defaults terminal.path to wt.exe under WindowsApps when the section is absent', () => {
  const raw = rawConfig();
  delete raw.terminal;
  assert.equal(
    validateConfig(raw, { LOCALAPPDATA: 'C:\\Local' }).terminal.path,
    'C:\\Local\\Microsoft\\WindowsApps\\wt.exe'
  );
});

test('defaults memory.suggestAfter to 3', () => {
  const raw = rawConfig();
  delete raw.memory;
  assert.equal(validateConfig(raw, {}).memory.suggestAfter, 3);
});

test('loadConfig accepts a file saved with a UTF-8 BOM', () => {
  const file = join(tempDir(), 'c.json');
  writeFileSync(file, '\uFEFF' + JSON.stringify(rawConfig()), 'utf8');
  assert.equal(loadConfig(file, {}).apps.teams.url, 'https://teams.microsoft.com/');
});

test('loadConfig reports invalid JSON clearly', () => {
  const file = join(tempDir(), 'c.json');
  writeFileSync(file, '{ nope', 'utf8');
  assert.throws(() => loadConfig(file, {}), /not valid JSON/);
});

test('the real jarvis.config.json is valid', () => {
  const c = loadConfig(join(import.meta.dirname, '..', 'jarvis.config.json'));
  assert.ok(c.routines.start_day);
  assert.ok(c.workspaces.agentic);
});

test('rejects an app url that does not start with http:// or https://', () => {
  const raw = rawConfig();
  raw.apps.teams.url = 'javascript:alert(1)';
  assert.throws(() => validateConfig(raw, {}), /apps\.teams\.url must start with http:\/\/ or https:\/\//);
});

test('rejects confirm if not a boolean on apps', () => {
  const raw = rawConfig();
  raw.apps.teams.confirm = 'yes';
  assert.throws(() => validateConfig(raw, {}), /apps\.teams\.confirm must be true or false/);
});

test('rejects confirm if not a boolean on routines', () => {
  const raw = rawConfig();
  raw.routines.start_day.confirm = 'yes';
  assert.throws(() => validateConfig(raw, {}), /routines\.start_day\.confirm must be true or false/);
});

test('rejects reserved keys like __proto__', () => {
  const raw = rawConfig();
  Object.defineProperty(raw.apps, '__proto__', { value: {description:'x', url:'https://x'}, enumerable: true, configurable: true, writable: true });
  assert.throws(() => validateConfig(raw, {}), /is reserved/);
});

test('face and voice sections default when absent', () => {
  const c = validateConfig(rawConfig(), {});
  assert.deepEqual(c.face, { display: 0, fullscreen: true });
  assert.deepEqual(c.voice, { voice: 'af_heart', wakeWord: 'hey izza', wakeWordModel: 'assets/hey-izza.ppn', listenTimeoutMs: 6000, maxUtteranceMs: 10000, asrModel: 'onnx-community/whisper-base.en' });
});

test('face and voice sections are validated', () => {
  const raw = rawConfig();
  raw.face = { display: 1, fullscreen: false };
  raw.voice = { voice: 'bm_george', listenTimeoutMs: 5000 };
  const c = validateConfig(raw, {});
  assert.deepEqual(c.face, { display: 1, fullscreen: false });
  assert.equal(c.voice.voice, 'bm_george');
  assert.equal(c.voice.listenTimeoutMs, 5000);
  assert.equal(c.voice.maxUtteranceMs, 10000);
  const bad = rawConfig(); bad.face = { display: -1 };
  assert.throws(() => validateConfig(bad, {}), /face\.display/);
  const bad2 = rawConfig(); bad2.voice = { listenTimeoutMs: 'soon' };
  assert.throws(() => validateConfig(bad2, {}), /voice\.listenTimeoutMs/);
});

test('voice.wakeWordModel defaults and can be overridden, and rejects a blank value', () => {
  const raw = rawConfig();
  raw.voice = { wakeWordModel: 'assets/custom.ppn' };
  assert.equal(validateConfig(raw, {}).voice.wakeWordModel, 'assets/custom.ppn');
  const bad = rawConfig(); bad.voice = { wakeWordModel: '   ' };
  assert.throws(() => validateConfig(bad, {}), /voice\.wakeWordModel/);
});

test('agent section defaults', () => {
  const c = validateConfig(rawConfig(), { LOCALAPPDATA: 'C:\\Local' });
  assert.deepEqual(c.agent, {
    enabled: true, maxWorkers: 3, managerModel: 'sonnet', workerModel: '',
    worktreeRoot: 'C:\\Local\\izza\\worktrees', projectsRoot: 'C:\\Zilmoney', atlassianUrl: 'https://mcp.atlassian.com/v2/mcp',
  });
});

test('agent section is validated', () => {
  const raw = rawConfig();
  raw.agent = { maxWorkers: 0 };
  assert.throws(() => validateConfig(raw, {}), /agent\.maxWorkers/);
  const raw2 = rawConfig();
  raw2.agent = { atlassianUrl: 'http://insecure' };
  assert.throws(() => validateConfig(raw2, {}), /agent\.atlassianUrl/);
});
