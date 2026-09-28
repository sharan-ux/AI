import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MANAGER_TOOLS, WORKER_TOOLS, createMcpHandler } from '../../src/agent/mcpServer.ts';

test('handler speaks the MCP basics', async () => {
  const calls: any[] = [];
  const h = createMcpHandler({ tools: WORKER_TOOLS, callTool: async (name, args) => { calls.push([name, args]); return '{"behavior":"allow"}'; } });
  const init: any = await h({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(await h({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const list: any = await h({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ['permission']);
  const call: any = await h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'permission', arguments: { tool_name: 'Write', input: {} } } });
  assert.equal(call.result.content[0].text, '{"behavior":"allow"}');
  const bad: any = await h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'start_worker', arguments: {} } });
  assert.equal(bad.error.code, -32602);
  const nope: any = await h({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(nope.error.code, -32601);
});

test('a failing tool returns isError content, not a crash', async () => {
  const h = createMcpHandler({ tools: MANAGER_TOOLS, callTool: async () => { throw new Error('boom'); } });
  const r: any = await h({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'speak', arguments: { text: 'x' } } });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /boom/);
});

test('manager tools include every spec tool', () => {
  const names = MANAGER_TOOLS.map((t) => t.name).sort();
  assert.deepEqual(names, ['ask_user', 'message_worker', 'open_terminal_tab', 'open_url', 'open_vscode', 'permission', 'recall', 'remember', 'speak', 'start_worker', 'stop_worker', 'worker_status']);
});

test('bin/izza-tools.ts forwards tool calls to the hub with the token', async () => {
  const seen: any[] = [];
  const hub = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ url: req.url, token: req.headers['x-izza-token'], body: JSON.parse(body) });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ text: 'forwarded ok' }));
    });
  });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  const port = (hub.address() as any).port;
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', '..', 'bin', 'izza-tools.ts')], {
    env: { ...process.env, IZZA_HUB_URL: `http://127.0.0.1:${port}`, IZZA_HUB_TOKEN: 'tok', IZZA_ACTOR: 'manager' },
  });
  const lines = createInterface({ input: child.stdout! });
  const reply = new Promise<any>((r) => lines.on('line', (l) => { const m = JSON.parse(l); if (m.id === 7) r(m); }));
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'speak', arguments: { text: 'hello' } } }) + '\n');
  const m = await reply;
  assert.equal(m.result.content[0].text, 'forwarded ok');
  assert.deepEqual(seen[0], { url: '/tool', token: 'tok', body: { actor: 'manager', name: 'speak', args: { text: 'hello' } } });
  child.kill();
  hub.close();
});

async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

function spawnTools(env: Record<string, string>) {
  return spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', '..', 'bin', 'izza-tools.ts')], {
    env: { ...process.env, ...env },
  });
}

function callOnce(child: ReturnType<typeof spawn>, id: number, name: string, args: Record<string, unknown>): Promise<any> {
  const lines = createInterface({ input: child.stdout! });
  const reply = new Promise<any>((r) => lines.on('line', (l) => { const m = JSON.parse(l); if (m.id === id) r(m); }));
  child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  return reply;
}

test('permission fails closed with a deny result when the hub is unreachable', async () => {
  const port = await closedPort();
  const child = spawnTools({ IZZA_HUB_URL: `http://127.0.0.1:${port}`, IZZA_HUB_TOKEN: 'tok', IZZA_ACTOR: 'worker:X' });
  const m = await callOnce(child, 1, 'permission', { tool_name: 'Write', input: {} });
  assert.ok(!m.result.isError);
  const payload = JSON.parse(m.result.content[0].text);
  assert.equal(payload.behavior, 'deny');
  assert.match(payload.message, /unreachable/);
  child.kill();
});

test('permission fails closed with a deny result when the hub returns a non-2xx', async () => {
  const hub = createServer((req, res) => {
    req.resume();
    req.on('end', () => res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'hub boom' })));
  });
  await new Promise<void>((r) => hub.listen(0, '127.0.0.1', r));
  const port = (hub.address() as any).port;
  const child = spawnTools({ IZZA_HUB_URL: `http://127.0.0.1:${port}`, IZZA_HUB_TOKEN: 'tok', IZZA_ACTOR: 'worker:X' });
  const m = await callOnce(child, 1, 'permission', { tool_name: 'Write', input: {} });
  assert.ok(!m.result.isError);
  const payload = JSON.parse(m.result.content[0].text);
  assert.equal(payload.behavior, 'deny');
  child.kill();
  hub.close();
});

test('a non-permission tool still reports isError when the hub is unreachable', async () => {
  const port = await closedPort();
  const child = spawnTools({ IZZA_HUB_URL: `http://127.0.0.1:${port}`, IZZA_HUB_TOKEN: 'tok', IZZA_ACTOR: 'manager' });
  const m = await callOnce(child, 1, 'speak', { text: 'hi' });
  assert.equal(m.result.isError, true);
  child.kill();
});
