import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { attachWorker } from '../main/speechWorkerCore.js';

function fakePort() {
  const port = new EventEmitter();
  port.messages = [];
  port.postMessage = (m) => port.messages.push(m);
  return port;
}

function fakeEngine() {
  return {
    ready: Promise.resolve(),
    speak: async (text) => ({ pcm: new Float32Array([text.length]), sampleRate: 24000 }),
    transcribe: async (pcm) => 'test transcription',
  };
}

test('speak op replies with {id, ok:true, result}', async () => {
  const port = fakePort();
  const engine = fakeEngine();
  attachWorker(port, engine);
  port.emit('message', { data: { id: 'sp1', op: 'speak', text: 'hello' } });
  await new Promise(r => setTimeout(r, 50));
  const reply = port.messages.find(m => m.id === 'sp1');
  assert(reply);
  assert.equal(reply.ok, true);
  assert(reply.result.pcm);
  assert.equal(reply.result.sampleRate, 24000);
});

test('transcribe op replies with {id, ok:true, result}', async () => {
  const port = fakePort();
  const engine = fakeEngine();
  attachWorker(port, engine);
  port.emit('message', { data: { id: 'tr1', op: 'transcribe', pcm: new Float32Array(16000) } });
  await new Promise(r => setTimeout(r, 50));
  const reply = port.messages.find(m => m.id === 'tr1');
  assert(reply);
  assert.equal(reply.ok, true);
  assert.equal(reply.result, 'test transcription');
});

test('unknown op replies with {id, ok:false, error}', async () => {
  const port = fakePort();
  const engine = fakeEngine();
  attachWorker(port, engine);
  port.emit('message', { data: { id: 'unk1', op: 'unknown', foo: 'bar' } });
  await new Promise(r => setTimeout(r, 50));
  const reply = port.messages.find(m => m.id === 'unk1');
  assert(reply);
  assert.equal(reply.ok, false);
  assert(reply.error.includes('unknown op'));
});

test('engine error replies with {id, ok:false, error}', async () => {
  const port = fakePort();
  const engine = {
    ready: Promise.resolve(),
    speak: async () => { throw new Error('speak failed'); },
    transcribe: async () => { throw new Error('transcribe failed'); },
  };
  attachWorker(port, engine);
  port.emit('message', { data: { id: 'err1', op: 'speak', text: 'fail' } });
  await new Promise(r => setTimeout(r, 50));
  const reply = port.messages.find(m => m.id === 'err1');
  assert(reply);
  assert.equal(reply.ok, false);
  assert.equal(reply.error, 'speak failed');
});

test('malformed message (no data) is ignored', async () => {
  const port = fakePort();
  const engine = fakeEngine();
  attachWorker(port, engine);
  assert.doesNotThrow(() => {
    port.emit('message', { nodata: 'empty' });
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(port.messages.length, 0);
});

test('message with no id is ignored', async () => {
  const port = fakePort();
  const engine = fakeEngine();
  attachWorker(port, engine);
  assert.doesNotThrow(() => {
    port.emit('message', { data: { op: 'speak', text: 'test' } });
  });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(port.messages.length, 0);
});
