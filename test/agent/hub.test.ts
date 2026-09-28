import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog } from '../../src/catalog.ts';
import { validateConfig } from '../../src/config.ts';
import { loadMemory } from '../../src/memory.ts';
import { createHub } from '../../src/agent/hub.ts';
import { rawConfig, tempDir } from '../fixtures.ts';

const FAKE = join(import.meta.dirname, '..', 'fixtures', 'fake-claude.mjs');
const waitFor = async (pred: () => boolean, ms = 8000) => { const t = Date.now(); while (!pred()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

function makeRepo(parent: string, name: string) {
  const dir = join(parent, name);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' });
  git('init', '-b', 'main'); git('config', 'user.email', 'izza@test'); git('config', 'user.name', 'Izza Test');
  writeFileSync(join(dir, 'a.txt'), 'hi'); git('add', '.'); git('commit', '-m', 'init');
  return dir;
}

async function setup({ answers = [] as (boolean | string | null)[], workerMode = 'done', managerMode = 'echo' } = {}) {
  const dir = tempDir();
  const projects = join(dir, 'Zilmoney');
  const repo = makeRepo(projects, 'payments-api');
  mkdirSync(join(projects, 'not-a-repo'));
  const raw = rawConfig();
  raw.agent = { projectsRoot: projects, worktreeRoot: join(dir, 'wt') };
  const config = validateConfig(raw, {});
  const catalog = buildCatalog(config);
  const memoryPath = join(dir, 'mem.txt');
  const asked: string[] = []; const said: string[] = []; const launched: any[] = [];
  const queue = [...answers];
  const hub = await createHub({
    config, root: dir, dataDir: join(dir, 'data'), memoryPath, catalog,
    askUser: async (q) => { asked.push(q); return queue.length ? queue.shift()! : null; },
    say: (t) => said.push(t), progress: () => {},
    launch: async (exe, args) => { launched.push({ exe, args }); },
    claudeCommand: (role) => ({ exe: process.execPath, prefixArgs: [FAKE, `--mode=${role === 'manager' ? managerMode : workerMode}`] }),
  });
  return { hub, dir, repo, projects, memoryPath, catalog, asked, said, launched };
}

test('hub HTTP rejects calls without the token', async () => {
  const s = await setup();
  const res = await fetch(`${s.hub.url}/tool`, { method: 'POST', body: JSON.stringify({ actor: 'manager', name: 'speak', args: { text: 'x' } }) });
  assert.equal(res.status, 403);
  s.hub.close();
});

test('permission: allow, deny and ask-with-voice decisions are enforced and logged', async () => {
  const s = await setup({ answers: [true, false] });
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-1', brief: 'do it' });
  const wt = join(s.dir, 'wt', 'payments-api', 'PAY-1');
  const perm = async (input: any, tool = 'Write') => JSON.parse(await s.hub.handleTool('worker:PAY-1', 'permission', { tool_name: tool, input }));
  assert.equal((await perm({ file_path: join(wt, 'x.ts'), content: '' })).behavior, 'allow');
  assert.equal((await perm({ file_path: join(s.repo, 'x.ts') })).behavior, 'deny');
  const yes = await perm({ command: 'git push origin izza/PAY-1' }, 'Bash');
  assert.equal(yes.behavior, 'allow');
  assert.deepEqual(yes.updatedInput, { command: 'git push origin izza/PAY-1' });
  assert.equal((await perm({ command: 'git push origin izza/PAY-1' }, 'Bash')).behavior, 'deny');
  assert.match(s.asked.at(-1)!, /git push origin izza\/PAY-1/);
  const log = readFileSync(join(s.dir, 'data', 'agent-log.jsonl'), 'utf8');
  assert.match(log, /"decision":"ask-yes"/);
  assert.match(log, /"decision":"ask-no"/);
  s.hub.close();
});

test('an unanswered ask times out as no', async () => {
  const dir = tempDir();
  const raw = rawConfig(); raw.agent = { projectsRoot: dir, worktreeRoot: join(dir, 'wt') };
  const config = validateConfig(raw, {});
  const hub = await createHub({
    config, root: dir, dataDir: join(dir, 'data'), memoryPath: join(dir, 'm.txt'), catalog: buildCatalog(config),
    askUser: () => new Promise(() => {}), say: () => {}, progress: () => {}, launch: async () => {}, askTimeoutMs: 50,
    claudeCommand: () => ({ exe: process.execPath, prefixArgs: [FAKE] }),
  });
  const r = JSON.parse(await hub.handleTool('manager', 'permission', { tool_name: 'mcp__atlassian__addCommentToJiraIssue', input: {} }));
  assert.equal(r.behavior, 'deny');
  assert.match(r.message, /no answer/i);
  hub.close();
});

test('start_worker asks for the folder once, matches a spoken name, remembers it, opens VS Code', async () => {
  const s = await setup({ answers: ['payments api'] });
  const out = await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-142', title: 'Reject empty amounts', brief: 'Reject empty payment amounts' });
  assert.match(out, /PAY-142/);
  assert.match(s.asked[0], /PAY project/);
  assert.match(s.asked[0], /payments-api/);
  assert.equal(loadMemory(s.memoryPath, s.catalog).projects.get('PAY'), s.repo);
  assert.ok(existsSync(join(s.dir, 'wt', 'payments-api', 'PAY-142', 'a.txt')));
  assert.ok(s.launched.some((l) => l.exe === s.hub.vscodePath && l.args[0].endsWith('PAY-142')));
  const board = JSON.parse(readFileSync(join(s.dir, 'data', 'tasks.json'), 'utf8'));
  assert.equal(board.tasks[0].branch, 'izza/PAY-142');
  s.hub.close();
});

test('a non-git folder answer is refused', async () => {
  const s = await setup({ answers: ['not a repo'] });
  await assert.rejects(s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-7', brief: 'x' }), /git/i);
  s.hub.close();
});

test('worker DONE reports reach the manager, and message_worker stops after 3 fix rounds', async () => {
  const s = await setup({ managerMode: 'echo' });
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  const injected: string[] = [];
  s.hub.onManagerTurn = (t: string) => injected.push(t);
  const doneCount = () => injected.filter((t) => t.startsWith('[worker PAY-2 · done]')).length;
  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-2', brief: 'do it' });
  await waitFor(() => doneCount() === 1);
  // Each fix message is sent only after the worker's previous DONE report lands, as the manager
  // really would; see fix round 1 item 4 (a fix round is now counted by verified status, not by
  // the last event's kind, so sending 3 messages without an intervening DONE would only count once).
  for (let i = 0; i < 3; i++) {
    await s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-2', text: `fix ${i}` });
    await waitFor(() => doneCount() === i + 2);
  }
  await assert.rejects(s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-2', text: 'fix 4' }), /3 fix rounds/);
  s.hub.close();
});

test('userTurn returns the manager reply; tools speak and open https only', async () => {
  const s = await setup();
  assert.equal(await s.hub.userTurn('look at PAY-142'), 'echo: look at PAY-142');
  await s.hub.handleTool('manager', 'speak', { text: 'PAY-142 is done.' });
  assert.deepEqual(s.said, ['PAY-142 is done.']);
  await assert.rejects(s.hub.handleTool('manager', 'open_url', { url: 'http://evil' }), /https/);
  await s.hub.handleTool('manager', 'open_url', { url: 'https://zilmoney.atlassian.net/browse/PAY-142' });
  assert.ok(s.launched.some((l) => l.args.includes('https://zilmoney.atlassian.net/browse/PAY-142')));
  s.hub.close();
});

// ---------- fix round 1 ----------

test('worker ids are validated: an injection-like id is rejected by stop_worker and open_terminal_tab, nothing launched, board unchanged', async () => {
  const s = await setup();
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-9', brief: 'do it' });
  const before = JSON.parse(readFileSync(join(s.dir, 'data', 'tasks.json'), 'utf8'));
  const evil = "X' $(calc) '";
  await assert.rejects(s.hub.handleTool('manager', 'stop_worker', { worker: evil }), /ticket/i);
  await assert.rejects(s.hub.handleTool('manager', 'open_terminal_tab', { worker: evil }), /ticket/i);
  await assert.rejects(s.hub.handleTool('manager', 'message_worker', { worker: evil, text: 'hi' }), /ticket/i);
  assert.equal(s.launched.filter((l) => JSON.stringify(l).toLowerCase().includes('calc')).length, 0);
  const after = JSON.parse(readFileSync(join(s.dir, 'data', 'tasks.json'), 'utf8'));
  assert.deepEqual(after.tasks.map((t: any) => t.id), before.tasks.map((t: any) => t.id));
  assert.ok(!after.tasks.some((t: any) => /calc|\$|'/.test(t.id)));
  s.hub.close();
});

test('permission denies outright for a worker actor with no (or incomplete) task record, instead of failing open to the repo', async () => {
  const s = await setup();
  const denyWrite = JSON.parse(await s.hub.handleTool('worker:GHOST-1', 'permission', { tool_name: 'Write', input: { file_path: join(process.cwd(), 'x.ts'), content: '' } }));
  assert.equal(denyWrite.behavior, 'deny');
  const denyBash = JSON.parse(await s.hub.handleTool('worker:GHOST-1', 'permission', { tool_name: 'Bash', input: { command: 'npm test' } }));
  assert.equal(denyBash.behavior, 'deny');
  s.hub.close();
});

test('remember project:<KEY> asks for confirmation, requires a repo root (not a subfolder), and rejects bogus project keys instead of saving them as facts', async () => {
  const s = await setup({ answers: [false] });
  await s.hub.handleTool('manager', 'remember', { key: 'project:PAY', value: s.repo });
  assert.match(s.asked.at(-1)!, /PAY project/i);
  assert.equal(loadMemory(s.memoryPath, s.catalog).projects.get('PAY'), undefined);

  const sub = join(s.repo, 'subdir');
  mkdirSync(sub);
  await assert.rejects(s.hub.handleTool('manager', 'remember', { key: 'project:PAY', value: sub }), /git/i);

  await assert.rejects(s.hub.handleTool('manager', 'remember', { key: 'projectX', value: 'whatever' }), /project/i);
  const mem = existsSync(s.memoryPath) ? readFileSync(s.memoryPath, 'utf8') : '';
  assert.doesNotMatch(mem, /projectX/i);
  s.hub.close();
});

test('fix-round cap counts a round by task status (verifying), not by the last event kind, and rapid duplicate messages count once', async () => {
  const s = await setup({ workerMode: 'done' });
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  const injected: string[] = [];
  s.hub.onManagerTurn = (t: string) => injected.push(t);
  const doneCount = () => injected.filter((t) => t.startsWith('[worker PAY-3 · done]')).length;
  const boardFile = join(s.dir, 'data', 'tasks.json');
  const roundsOf = () => JSON.parse(readFileSync(boardFile, 'utf8')).tasks.find((t: any) => t.id === 'PAY-3').rounds;

  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-3', brief: 'do it' });
  await waitFor(() => doneCount() === 1);

  // Simulate an intervening non-status event (e.g. a stall) overwriting lastKind; status stays 'verifying'.
  const b1 = JSON.parse(readFileSync(boardFile, 'utf8'));
  b1.tasks.find((t: any) => t.id === 'PAY-3').lastKind = 'stalled';
  writeFileSync(boardFile, JSON.stringify(b1, null, 2));

  // Two rapid messages sent before either reply lands must count as ONE round.
  await s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-3', text: 'fix 0a' });
  await s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-3', text: 'fix 0b' });
  await waitFor(() => doneCount() >= 3);
  assert.equal(roundsOf(), 1);

  await s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-3', text: 'fix 1' });
  await waitFor(() => doneCount() >= 4);
  await s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-3', text: 'fix 2' });
  await waitFor(() => doneCount() >= 5);
  assert.equal(roundsOf(), 3);

  await assert.rejects(s.hub.handleTool('manager', 'message_worker', { worker: 'PAY-3', text: 'fix 3' }), /3 fix rounds/);
  s.hub.close();
});

test('the HTTP handler derives the actor from a per-actor token and ignores the body actor', async () => {
  const s = await setup();
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-5', brief: 'do it' });
  const cfgFile = join(s.dir, 'data', 'agent', 'mcp-worker_PAY-5.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const workerToken = cfg.mcpServers.izza.env.IZZA_HUB_TOKEN;
  assert.ok(typeof workerToken === 'string' && workerToken.length > 10);
  const res = await fetch(`${s.hub.url}/tool`, {
    method: 'POST',
    headers: { 'x-izza-token': workerToken },
    body: JSON.stringify({ actor: 'manager', name: 'start_worker', args: { ticket: 'PAY-6', brief: 'sneaky' } }),
  });
  const body: any = await res.json();
  assert.notEqual(res.status, 200);
  assert.match(String(body.error ?? ''), /worker/i);
  const board = JSON.parse(readFileSync(join(s.dir, 'data', 'tasks.json'), 'utf8'));
  assert.ok(!board.tasks.some((t: any) => t.id === 'PAY-6'));
  s.hub.close();
});

test('open_vscode with an explicit path must resolve inside the manager\'s projects/worktree roots and must not start with "-"', async () => {
  const s = await setup();
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  await assert.rejects(s.hub.handleTool('manager', 'open_vscode', { path: '-rf' }), /invalid path/i);
  await assert.rejects(s.hub.handleTool('manager', 'open_vscode', { path: join(s.dir, 'outside') }), /outside/i);
  await s.hub.handleTool('manager', 'open_vscode', { path: s.repo });
  assert.ok(s.launched.some((l) => l.exe === s.hub.vscodePath && l.args[0] === s.repo));
  s.hub.close();
});

test('a manager crash mid-turn resolves userTurn with a friendly message instead of rejecting', async () => {
  const s = await setup({ managerMode: 'crash' });
  const reply = await s.hub.userTurn('hello');
  assert.match(reply, /something went wrong/i);
  s.hub.close();
});

test('resolveProject prefers the longest matching basename over a shorter substring match', async () => {
  const s = await setup({ answers: ['payments api'] });
  mkdirSync(join(s.projects, 'pay'));
  const out = await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-200', brief: 'x' });
  assert.match(out, /PAY-200/);
  assert.equal(loadMemory(s.memoryPath, s.catalog).projects.get('PAY'), s.repo);
  s.hub.close();
});

// ---------- fix round 2 ----------

test('start_worker rejects a project key containing control characters instead of injecting a memory line, and never asks', async () => {
  const s = await setup();
  const before = existsSync(s.memoryPath) ? readFileSync(s.memoryPath, 'utf8') : '';
  await assert.rejects(
    s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-1', project: 'X\nPROJECT: FOO => C:\\', brief: 'x' }),
    /project/i,
  );
  assert.equal(s.asked.length, 0);
  const after = existsSync(s.memoryPath) ? readFileSync(s.memoryPath, 'utf8') : '';
  assert.equal(after, before);
  s.hub.close();
});

test('starting an already-running worker does not invalidate its live token', async () => {
  const s = await setup();
  writeFileSync(s.memoryPath, `project: PAY => ${s.repo}\n`);
  await s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-8', brief: 'do it' });
  const cfgFile = join(s.dir, 'data', 'agent', 'mcp-worker_PAY-8.json');
  const cfg = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const token = cfg.mcpServers.izza.env.IZZA_HUB_TOKEN;
  await assert.rejects(s.hub.handleTool('manager', 'start_worker', { ticket: 'PAY-8', brief: 'again' }), /already running/i);
  const res = await fetch(`${s.hub.url}/tool`, {
    method: 'POST',
    headers: { 'x-izza-token': token },
    body: JSON.stringify({ name: 'permission', args: { tool_name: 'Bash', input: { command: 'npm test' } } }),
  });
  assert.equal(res.status, 200);
  const body: any = await res.json();
  assert.equal(JSON.parse(body.text).behavior, 'allow');
  s.hub.close();
});

test('remember project:<KEY> confirmation respects the ask timeout (unanswered stays not remembered)', async () => {
  const dir = tempDir();
  const repo = makeRepo(dir, 'timeout-repo');
  const raw = rawConfig(); raw.agent = { projectsRoot: dir, worktreeRoot: join(dir, 'wt') };
  const config = validateConfig(raw, {});
  const catalog = buildCatalog(config);
  const memoryPath = join(dir, 'mem.txt');
  const hub = await createHub({
    config, root: dir, dataDir: join(dir, 'data'), memoryPath, catalog,
    askUser: () => new Promise(() => {}), say: () => {}, progress: () => {}, launch: async () => {}, askTimeoutMs: 50,
    claudeCommand: () => ({ exe: process.execPath, prefixArgs: [FAKE] }),
  });
  const out = await hub.handleTool('manager', 'remember', { key: 'project:PAY', value: repo });
  assert.match(out, /not remembered/i);
  assert.equal(loadMemory(memoryPath, catalog).projects.get('PAY'), undefined);
  hub.close();
});
