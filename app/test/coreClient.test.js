import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CoreClient } from '../main/coreClient.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
  c.written = [];
  c.stdin.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) c.written.push(JSON.parse(l)); });
  c.kill = () => c.emit('close', null);
  return c;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(opts = {}) {
  const children = [];
  let t = 0;
  const client = new CoreClient({ spawn: () => { const c = fakeChild(); children.push(c); return c; }, now: () => t, ...opts });
  const events = [];
  for (const e of ['message', 'restarting', 'down']) client.on(e, (x) => events.push([e, x]));
  client.start();
  return { client, children, events, advance: (ms) => { t += ms; } };
}

test('forwards JSON lines from the core and flags non-JSON', async () => {
  const { children, events } = setup();
  children[0].stdout.write('{"type":"ready","status":"ok"}\nhello\n');
  await tick();
  assert.deepEqual(events[0], ['message', { type: 'ready', status: 'ok' }]);
  assert.equal(events[1][1].type, 'warning');
});

test('send writes one JSON line', async () => {
  const { client, children } = setup();
  assert.equal(client.send({ type: 'command', id: 'c1', text: 'hi' }), true);
  await tick();
  assert.deepEqual(children[0].written, [{ type: 'command', id: 'c1', text: 'hi' }]);
});

test('a crash fails the in-flight command and restarts the core', async () => {
  const { client, children, events } = setup();
  client.send({ type: 'command', id: 'c1', text: 'hi' });
  children[0].emit('close', 1);
  await tick();
  const done = events.find(([e, m]) => e === 'message' && m.type === 'done');
  assert.equal(done[1].id, 'c1');
  assert.equal(done[1].outcome, 'failed');
  assert.ok(events.some(([e]) => e === 'restarting'));
  assert.equal(children.length, 2);
});

test('completed commands are not failed on a later crash', async () => {
  const { client, children, events } = setup();
  client.send({ type: 'command', id: 'c1', text: 'hi' });
  children[0].stdout.write('{"type":"done","id":"c1","outcome":"executed","say":"ok","lines":[]}\n');
  await tick();
  children[0].emit('close', 1);
  await tick();
  assert.equal(events.filter(([e, m]) => e === 'message' && m.type === 'done').length, 1);
});

test('more than 3 crashes within a minute gives up', async () => {
  const { children, events } = setup();
  for (let i = 0; i < 4; i++) { children[children.length - 1].emit('close', 1); await tick(); }
  assert.equal(children.length, 4);
  assert.ok(events.some(([e]) => e === 'down'));
});

test('crashes spread over time keep restarting', async () => {
  const { children, events, advance } = setup();
  for (let i = 0; i < 5; i++) { children[children.length - 1].emit('close', 1); await tick(); advance(61000); }
  assert.equal(children.length, 6);
  assert.ok(!events.some(([e]) => e === 'down'));
});

test('stop does not restart', async () => {
  const { client, children } = setup();
  client.stop();
  await tick();
  assert.equal(children.length, 1);
  assert.equal(client.send({ type: 'command', id: 'c2', text: 'x' }), false);
});

test('close-vs-exit: done message + close in same tick = real outcome', async () => {
  const { client, children, events } = setup();
  client.send({ type: 'command', id: 'c1', text: 'hi' });
  children[0].stdout.write('{"type":"done","id":"c1","outcome":"executed","say":"ok","lines":[]}\n');
  children[0].emit('close', 1);
  await tick();
  const dones = events.filter(([e, m]) => e === 'message' && m.type === 'done' && m.id === 'c1');
  assert.equal(dones.length, 1);
  assert.equal(dones[0][1].outcome, 'executed');
});

test('start() resets stopping so crashed client can restart', async () => {
  const { client, children, events } = setup();
  client.stop();
  await tick();
  assert.equal(children.length, 1);
  events.length = 0;
  client.start();
  await tick();
  assert.equal(children.length, 2);
  children[children.length - 1].emit('close', 1);
  await tick();
  assert.ok(events.some(([e]) => e === 'restarting'));
  assert.equal(children.length, 3);
});

test('spawn error followed by close triggers warning and restart', async () => {
  const { children, events } = setup();
  children[0].emit('error', new Error('spawn ENOENT'));
  children[0].emit('close', 1);
  await tick();
  const warning = events.find(([e, m]) => e === 'message' && m.type === 'warning');
  assert.ok(warning);
  assert.ok(events.some(([e]) => e === 'restarting'));
  assert.equal(children.length, 2);
});

test('stdin error does not throw', async () => {
  const { children } = setup();
  let threw = false;
  try {
    children[0].stdin.emit('error', new Error('EPIPE'));
  } catch {
    threw = true;
  }
  assert.equal(threw, false);
});
