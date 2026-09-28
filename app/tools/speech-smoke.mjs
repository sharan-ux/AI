import { createSpeechEngine } from '../main/speechEngine.js';

// Speak a reply with the real voice, then transcribe that audio back.
const t0 = Date.now();
const engine = createSpeechEngine({ onProgress: (p) => process.stdout.write(`\rdownloading ${p}%   `) });
await engine.ready;
console.log(`\nmodels ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
let s = Date.now();
const { pcm, sampleRate } = await engine.speak('Opening Teams.');
console.log(`speak: ${((Date.now() - s) / 1000).toFixed(2)} s for ${(pcm.length / sampleRate).toFixed(2)} s of audio`);
s = Date.now();
await engine.speak('Opening Teams.');
console.log(`cached speak: ${Date.now() - s} ms`);
const pcm16 = new Float32Array(Math.floor((pcm.length * 16000) / sampleRate));
for (let i = 0; i < pcm16.length; i++) pcm16[i] = pcm[Math.floor((i * sampleRate) / 16000)];
s = Date.now();
console.log(`transcribe: "${await engine.transcribe(pcm16)}" in ${((Date.now() - s) / 1000).toFixed(2)} s`);
