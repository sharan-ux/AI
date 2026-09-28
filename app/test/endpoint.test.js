import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointer } from '../renderer/endpoint.js';

const frame = (amp) => Float32Array.from({ length: 480 }, (_, i) => amp * Math.sin(i / 5));
const LOUD = 0.2, QUIET = 0.001;

test('ends after speech followed by 900 ms of silence', () => {
  const ep = createEndpointer({ frameMs: 30 });
  for (let i = 0; i < 20; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
  for (let i = 0; i < 29; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  assert.equal(ep.push(frame(QUIET)), 'end');
  assert.equal(ep.audio().length, 50 * 480);
});

test('times out when nobody speaks', () => {
  const ep = createEndpointer({ frameMs: 30, noSpeechMs: 6000 });
  for (let i = 0; i < 199; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  assert.equal(ep.push(frame(QUIET)), 'timeout');
});

test('stops at the maximum utterance length', () => {
  const ep = createEndpointer({ frameMs: 30, maxMs: 10000 });
  for (let i = 0; i < 333; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
  assert.equal(ep.push(frame(LOUD)), 'end');
});

test('pre-roll audio is kept at the start', () => {
  const ep = createEndpointer({ frameMs: 30, preRoll: new Float32Array([0.5, 0.25]) });
  ep.push(frame(LOUD));
  const a = ep.audio();
  assert.equal(a.length, 482);
  assert.equal(a[0], 0.5);
  assert.equal(a[1], 0.25);
});

test('pauses shorter than 900 ms do not end the utterance', () => {
  const ep = createEndpointer({ frameMs: 30 });
  for (let i = 0; i < 10; i++) ep.push(frame(LOUD));
  for (let i = 0; i < 20; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  for (let i = 0; i < 10; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
});
