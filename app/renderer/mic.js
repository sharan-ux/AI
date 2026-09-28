import { createEndpointer } from './endpoint.js';

// Always-on local capture at 16 kHz with a rolling pre-roll buffer. Nothing leaves the machine.
export async function createMic({ preRollMs = 500 } = {}) {
  let stream = null, ctx = null, proc = null;
  let ring = [], ringLen = 0, active = null;
  const maxRing = (16000 * preRollMs) / 1000;

  async function open() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    ctx = new AudioContext({ sampleRate: 16000 });
    const src = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(512, 1, 1);
    proc.onaudioprocess = (e) => {
      const f = new Float32Array(e.inputBuffer.getChannelData(0));
      if (active) {
        const r = active.ep.push(f);
        if (r !== 'continue') { const a = active; active = null; a.resolve(r === 'end' ? a.ep.audio() : null); }
      } else {
        ring.push(f); ringLen += f.length;
        while (ring.length && ringLen - ring[0].length >= maxRing) ringLen -= ring.shift().length;
      }
    };
    src.connect(proc);
    proc.connect(ctx.destination);
  }

  async function close() {
    stream?.getTracks().forEach((t) => t.stop());
    await ctx?.close();
    stream = ctx = proc = null;
    ring = []; ringLen = 0;
  }

  function cancel() { if (active) { const a = active; active = null; a.resolve(null); } }

  await open();
  return {
    startUtterance({ noSpeechMs, maxMs }) {
      cancel();
      const preRoll = new Float32Array(ringLen);
      let o = 0; for (const c of ring) { preRoll.set(c, o); o += c.length; }
      ring = []; ringLen = 0;
      if (!ctx) return Promise.resolve(null);
      return new Promise((resolve) => { active = { ep: createEndpointer({ noSpeechMs, maxMs, preRoll }), resolve }; });
    },
    cancel,
    async setMuted(m) { cancel(); if (m) await close(); else if (!ctx) await open(); },
  };
}
