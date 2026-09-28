import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { ClaudeProcess, buildClaudeArgs, describeEvent, userTurn } from '../../src/agent/claudeProcess.ts';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
const fake = (mode: string) => new ClaudeProcess({ exe: process.execPath, args: [FAKE, `--mode=${mode}`], cwd: process.cwd() });

test('buildClaudeArgs always forces default permission mode and the Izza gate', () => {
  const a = buildClaudeArgs({ sessionId: 's1', resume: false, model: 'sonnet', mcpConfigPath: 'C:\\m.json', systemPromptFile: 'C:\\p.md', addDirs: ['C:\\x'], disallowedTools: ['Write'] });
  assert.deepEqual(a.slice(0, 3), ['-p', '--permission-mode', 'default']);
  for (const flag of ['--input-format', '--output-format', '--verbose', '--strict-mcp-config', '--session-id']) assert.ok(a.includes(flag), flag);
  assert.equal(a[a.indexOf('--permission-prompt-tool') + 1], 'mcp__izza__permission');
  assert.equal(a[a.indexOf('--add-dir') + 1], 'C:\\x');
  assert.equal(a[a.indexOf('--disallowedTools') + 1], 'Write');
  const r = buildClaudeArgs({ sessionId: 's1', resume: true, mcpConfigPath: 'm', systemPromptFile: 'p', addDirs: [], disallowedTools: [] });
  assert.equal(r[r.indexOf('--resume') + 1], 's1');
  assert.ok(!r.includes('--model'));
});

test('userTurn is one stream-json user line', () => {
  assert.deepEqual(JSON.parse(userTurn('hi')), { type: 'user', message: { role: 'user', content: 'hi' } });
});

test('send returns each turn result in order on one long-lived process', async () => {
  const p = fake('echo');
  p.start();
  const a = await p.send('one');
  const b = await p.send('two');
  assert.equal(a.text, 'echo: one');
  assert.equal(b.text, 'echo: two');
  assert.equal(b.sessionId, 'fake-session');
  p.stop();
});

test('a crash rejects pending turns and emits exit', async () => {
  const p = fake('crash-after-first');
  const exited = new Promise((r) => p.once('exit', r));
  p.start();
  await p.send('one');
  await assert.rejects(p.send('two'), /exited/);
  await exited;
  assert.equal(p.running, false);
});

test('describeEvent summarizes assistant text and tool use', () => {
  assert.equal(describeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }] } }), 'Bash npm test');
  assert.equal(describeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Adding validator' }] } }), 'Adding validator');
  assert.equal(describeEvent({ type: 'system', subtype: 'init' }), null);
});
