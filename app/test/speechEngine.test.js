import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, createSpeechEngine } from '../main/speechEngine.js';

function fakes() {
  const calls = { tts: 0, asr: 0 };
  const loadTts = async () => ({ generate: async (text) => { calls.tts++; return { audio: new Float32Array([text.length]), sampling_rate: 24000 }; } });
  const loadAsr = async () => async () => { calls.asr++; return { text: ' Open Teams. ' }; };
  return { calls, loadTts, loadAsr };
}

test('speak returns PCM and caches repeats', async () => {
  const f = fakes();
  const e = createSpeechEngine({ loadTts: f.loadTts, loadAsr: f.loadAsr });
  await e.ready;
  const a = await e.speak('Opening Teams.');
  const b = await e.speak('Opening Teams.');
  assert.equal(a.sampleRate, 24000);
  assert.equal(a, b);
  assert.equal(f.calls.tts, 2); // 1 warm-up + 1 real
});

test('transcribe trims text', async () => {
  const f = fakes();
  const e = createSpeechEngine({ loadTts: f.loadTts, loadAsr: f.loadAsr });
  assert.equal(await e.transcribe(new Float32Array(16000)), 'Open Teams.');
});

test('cleanTranscript drops Whisper filler for silence', () => {
  for (const t of ['[BLANK_AUDIO]', ' (silence) ', 'Thank you.', 'you']) assert.equal(cleanTranscript(t), '');
  assert.equal(cleanTranscript(' open teams '), 'open teams');
});

test('cleanTranscript drops additional Whisper filler phrases', () => {
  for (const t of ['Thank you!', 'Thanks for watching!', 'Bye.', 'Bye!', '.', '...']) assert.equal(cleanTranscript(t), '');
});

test('progress aggregates files keyed by model+filename', async () => {
  const progresses = [];
  const loadTts = async ({ onProgress }) => {
    onProgress({ status: 'progress', name: 'kokoro', file: 'config.json', loaded: 1, total: 2 });
    return { generate: async () => ({ audio: new Float32Array(), sampling_rate: 24000 }) };
  };
  const loadAsr = async ({ onProgress }) => {
    onProgress({ status: 'progress', name: 'whisper', file: 'config.json', loaded: 2, total: 2 });
    return async () => ({ text: 'test' });
  };
  const e = createSpeechEngine({
    loadTts,
    loadAsr,
    onProgress: (p) => progresses.push(p),
  });
  await e.ready;
  assert.equal(progresses[progresses.length - 1], 75); // kokoro 50% + whisper 100% = 75% avg
});

test('concurrent speak of same text deduplicates generate calls', async () => {
  const f = fakes();
  const e = createSpeechEngine({ loadTts: f.loadTts, loadAsr: f.loadAsr });
  await e.ready;
  const [a, b] = await Promise.all([
    e.speak('Opening Teams.'),
    e.speak('Opening Teams.'),
  ]);
  assert.equal(a, b);
  assert.equal(f.calls.tts, 2); // 1 warm-up + 1 real (not 3)
});

test('concurrent speak of different texts serializes generate', async () => {
  let maxConcurrency = 0;
  let currentConcurrency = 0;
  const loadTts = async () => ({
    generate: async (text) => {
      currentConcurrency++;
      maxConcurrency = Math.max(maxConcurrency, currentConcurrency);
      await new Promise(r => setTimeout(r, 10));
      currentConcurrency--;
      return { audio: new Float32Array([text.length]), sampling_rate: 24000 };
    },
  });
  const loadAsr = async () => async () => ({ text: 'test' });
  const e = createSpeechEngine({ loadTts, loadAsr });
  await e.ready;
  await Promise.all([e.speak('A'), e.speak('B')]);
  assert.equal(maxConcurrency, 1); // never concurrent
});

test('queue survives generate rejection; subsequent speak() succeeds', async () => {
  let generateCalls = 0;
  const loadTts = async () => ({
    generate: async (text) => {
      generateCalls++;
      if (text === 'bad') throw new Error('bad text');
      return { audio: new Float32Array([text.length]), sampling_rate: 24000 };
    },
  });
  const loadAsr = async () => async () => ({ text: 'test' });
  const e = createSpeechEngine({ loadTts, loadAsr });
  await e.ready;
  const warmupCalls = generateCalls; // Note warm-up call

  // First speak fails
  await assert.rejects(e.speak('bad'), /bad text/);
  assert.equal(generateCalls, warmupCalls + 1);

  // Second speak succeeds (queue not poisoned)
  const result = await e.speak('good');
  assert(result.pcm);
  assert.equal(generateCalls, warmupCalls + 2);
});

test('rejected speak twice sequentially attempts generate twice', async () => {
  let generateCalls = 0;
  const loadTts = async () => ({
    generate: async (text) => {
      generateCalls++;
      if (text === 'bad') throw new Error('bad text');
      return { audio: new Float32Array([text.length]), sampling_rate: 24000 };
    },
  });
  const loadAsr = async () => async () => ({ text: 'test' });
  const e = createSpeechEngine({ loadTts, loadAsr });
  await e.ready;
  const warmupCalls = generateCalls; // Note warm-up call

  // First speak('bad') fails
  await assert.rejects(e.speak('bad'), /bad text/);
  assert.equal(generateCalls, warmupCalls + 1);

  // Second speak('bad') should retry, not reuse stale promise
  await assert.rejects(e.speak('bad'), /bad text/);
  assert.equal(generateCalls, warmupCalls + 2); // generate called again
});
