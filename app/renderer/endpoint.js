// Decides when an utterance is over, from 16 kHz mono frames. Pure — no Web Audio.
export function createEndpointer({
  sampleRate = 16000, frameMs, threshold = 0.012, silenceMs = 900, maxMs = 10000, noSpeechMs = 6000,
  preRoll = new Float32Array(0),
} = {}) {
  const chunks = preRoll.length ? [preRoll] : [];
  let elapsed = 0, silence = 0, spoke = false;
  return {
    push(frame) {
      chunks.push(frame);
      const ms = frameMs ?? (frame.length / sampleRate) * 1000;
      elapsed += ms;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / Math.max(1, frame.length));
      if (rms > threshold) { spoke = true; silence = 0; } else if (spoke) { silence += ms; }
      if (spoke && silence >= silenceMs) return 'end';
      if (elapsed >= maxMs) return spoke ? 'end' : 'timeout';
      if (!spoke && elapsed >= noSpeechMs) return 'timeout';
      return 'continue';
    },
    audio() {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }
      return out;
    },
  };
}
