// Plays synthesized PCM and reports its live level (0–1) so the burn follows the real voice.
export function createPlayer({ onAmplitude }) {
  const ctx = new AudioContext();
  let current = null;
  const stop = () => { if (current) { try { current.stop(); } catch { /* already stopped */ } } };
  return {
    stop,
    play(pcm, sampleRate) {
      stop();
      if (!pcm || !pcm.length) return Promise.resolve();
      return new Promise((resolve) => {
        const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
        buffer.copyToChannel(pcm, 0);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        src.connect(analyser);
        analyser.connect(ctx.destination);
        const data = new Float32Array(analyser.fftSize);
        let raf = 0;
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += v * v;
          onAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        let done = false, safety = 0;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(safety);
          cancelAnimationFrame(raf);
          try { src.disconnect(); } catch { /* already disconnected */ }
          try { analyser.disconnect(); } catch { /* already disconnected */ }
          if (current === src) { current = null; onAmplitude(null); }
          resolve();
        };
        src.onended = finish;
        current = src;
        safety = setTimeout(() => { try { src.stop(); } catch { /* already stopped */ } finish(); }, (pcm.length / sampleRate) * 1000 + 2000);
        try {
          ctx.resume().then(() => { src.start(); tick(); }).catch(finish);
        } catch {
          finish();
        }
      });
    },
    chime() {
      try {
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
        osc.connect(gain); gain.connect(ctx.destination);
        ctx.resume().then(() => { osc.start(); osc.stop(ctx.currentTime + 0.26); }).catch(() => {});
      } catch { /* chime is best-effort */ }
    },
  };
}
