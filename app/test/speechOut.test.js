import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechOut } from '../renderer/speechOut.js';

function fakePlayer() {
  const calls = [];
  return { calls, play: async (pcm, sampleRate) => { calls.push(['play', pcm, sampleRate]); }, stop: () => { calls.push('stop'); } };
}

test('speak plays the synthesized audio', async () => {
  const player = fakePlayer();
  const synth = async (text) => ({ pcm: text, sampleRate: 24000 });
  const out = createSpeechOut({ synth, player });
  await out.speak('hello');
  assert.deepEqual(player.calls, [['play', 'hello', 24000]]);
});

test('stop during synthesis discards the result; play is never called', async () => {
  const player = fakePlayer();
  let resolveSynth;
  const synth = () => new Promise((r) => { resolveSynth = r; });
  const out = createSpeechOut({ synth, player });
  const p = out.speak('hello');
  out.stop(); // barge-in / mute / typing while still synthesizing
  resolveSynth({ pcm: 'hello', sampleRate: 24000 });
  await p;
  assert.deepEqual(player.calls, ['stop']);
});

test('a falsy synth result (voice unavailable) plays nothing', async () => {
  const player = fakePlayer();
  const out = createSpeechOut({ synth: async () => null, player });
  await out.speak('hello');
  assert.deepEqual(player.calls, []);
});

test('stop always stops the player, even with nothing in flight', () => {
  const player = fakePlayer();
  const out = createSpeechOut({ synth: async () => null, player });
  out.stop();
  assert.deepEqual(player.calls, ['stop']);
});

test('a second speak() after a stopped one plays normally', async () => {
  const player = fakePlayer();
  let resolveFirst;
  let calls = 0;
  const synth = async () => {
    calls++;
    if (calls === 1) return new Promise((r) => { resolveFirst = r; });
    return { pcm: 'second', sampleRate: 24000 };
  };
  const out = createSpeechOut({ synth, player });
  const p1 = out.speak('first');
  out.stop();
  resolveFirst({ pcm: 'first', sampleRate: 24000 });
  await p1;
  await out.speak('second');
  assert.deepEqual(player.calls, ['stop', ['play', 'second', 24000]]);
});
