import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCatalog } from '../../src/catalog.ts';
import { buildClaudeArgs, createClaudeCodeBrain, parseClaudeOutput, runProcess } from '../../src/brains/claudeCode.ts';
import { sampleConfig, tempDir } from '../fixtures.ts';

const cat = buildCatalog(sampleConfig());

test('runs claude with tools disabled and structured output', () => {
  const args = buildClaudeArgs('haiku', 'SYS', { type: 'object' });
  assert.deepEqual(args.slice(0, 9), ['-p', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'json', '--system-prompt']);
  assert.equal(args[9], 'SYS');
  assert.equal(args[10], '--json-schema');
  assert.deepEqual(JSON.parse(args[11]), { type: 'object' });
});

test('parses structured_output', () => {
  const out = JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { choice: 'run_routine:start_day', confidence: 0.93 } });
  assert.deepEqual(parseClaudeOutput(out, cat), { intent: 'run_routine', target: 'start_day', confidence: 0.93, source: 'claude-code' });
});

test('falls back to parsing the result string', () => {
  const out = JSON.stringify({ is_error: false, result: '{"choice":"open_app:teams","confidence":0.7}' });
  assert.equal(parseClaudeOutput(out, cat).target, 'teams');
});

test('non-JSON output throws', () => {
  assert.throws(
    () => parseClaudeOutput('Error: something', cat),
    /claude output was not JSON: Error: something/
  );
});

test('no structured_output and no parsable result throws a no-decision error', () => {
  assert.throws(
    () => parseClaudeOutput(JSON.stringify({ is_error: false, result: 'not json' }), cat),
    /claude returned no decision: not json/
  );
});

test('an is_error result throws so the chain can report it', () => {
  assert.throws(() => parseClaudeOutput(JSON.stringify({ is_error: true, result: 'Not logged in' }), cat), /Not logged in/);
});

test('the brain sends the user text on stdin to the configured exe', async () => {
  const calls: any[] = [];
  const brain = createClaudeCodeBrain({
    exe: 'C:\\claude.exe',
    model: 'haiku',
    run: async (exe, args, input) => {
      calls.push({ exe, args, input });
      return JSON.stringify({ is_error: false, structured_output: { choice: 'open_app:teams', confidence: 0.9 } });
    },
  });
  const d = await brain.decide('please open teams', cat, []);
  assert.equal(d?.target, 'teams');
  assert.equal(calls[0].exe, 'C:\\claude.exe');
  assert.equal(calls[0].input, 'please open teams');
});

test('runProcess echoes stdin from node', async () => {
  const out = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], 'hello', 5000);
  assert.equal(out, 'hello');
});

test('runProcess rejects on non-zero exit', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'process.stderr.write("bad"); process.exit(3)'], '', 5000),
    /exited with code 3: bad/
  );
});

test('runProcess rejects on timeout', async () => {
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], '', 300),
    /timed out/
  );
});

test('runProcess rejects on missing exe without crashing test', async () => {
  await assert.rejects(
    runProcess(join(tempDir(), 'nope.exe'), [], 'x', 5000),
    /ENOENT|cannot find/i
  );
});
