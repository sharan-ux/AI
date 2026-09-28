import { ReplyCache } from './replyCache.js';

const FILLER = /^(\[.*\]|\(.*\)|thank you[.!]?|thanks( for watching)?[.!]?|bye[.!]?|you\.?|\.{1,3})$/i;
export function cleanTranscript(text) {
  const t = String(text ?? '').trim();
  return FILLER.test(t) ? '' : t;
}

async function defaultTts({ cacheDir, onProgress }) {
  const { env } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  const { KokoroTTS } = await import('kokoro-js');
  return KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', { dtype: 'fp32', device: 'cpu', progress_callback: onProgress });
}

async function defaultAsr({ asrModel, cacheDir, onProgress }) {
  const { env, pipeline } = await import('@huggingface/transformers');
  if (cacheDir) env.cacheDir = cacheDir;
  return pipeline('automatic-speech-recognition', asrModel, { dtype: 'fp32', device: 'cpu', progress_callback: onProgress });
}

// Local text-to-speech (Kokoro) and speech-to-text (Whisper). Runs in plain Node or an Electron utilityProcess.
export function createSpeechEngine({
  voice = 'af_heart', asrModel = 'onnx-community/whisper-base.en', cacheDir,
  onProgress = () => {}, loadTts = defaultTts, loadAsr = defaultAsr,
} = {}) {
  const cache = new ReplyCache(200);
  const files = new Map();
  const progress = (p) => {
    if (p?.status !== 'progress' || !p.total) return;
    files.set(`${p.name}|${p.file}`, p.loaded / p.total);
    const values = [...files.values()];
    onProgress(Math.round((100 * values.reduce((a, b) => a + b, 0)) / values.length));
  };
  let tts, asr;
  const ready = (async () => {
    [tts, asr] = await Promise.all([
      loadTts({ cacheDir, onProgress: progress }),
      loadAsr({ asrModel, cacheDir, onProgress: progress }),
    ]);
    await tts.generate('Ready.', { voice });   // warm-up so the first real reply is fast
  })();

  const speakInFlight = new Map();
  let generateQueue = Promise.resolve();

  return {
    ready,
    async speak(text) {
      await ready;
      const hit = cache.get(voice, text);
      if (hit) return hit;

      const textKey = String(text).trim();
      // De-duplicate in-flight requests for the same text
      if (speakInFlight.has(textKey)) return speakInFlight.get(textKey);

      // Serialize generate calls, keep queue alive on rejection
      const promise = (async () => {
        const run = generateQueue.then(async () => {
          const audio = await tts.generate(String(text), { voice });
          const value = { pcm: audio.audio, sampleRate: audio.sampling_rate };
          cache.set(voice, text, value);
          return value;
        });
        generateQueue = run.catch(() => {}); // Keep chain alive on rejection
        return run; // Caller still sees the rejection
      })();

      speakInFlight.set(textKey, promise);
      try {
        return await promise;
      } finally {
        speakInFlight.delete(textKey);
      }
    },
    async transcribe(pcm) {
      await ready;
      const r = await asr(pcm);
      return cleanTranscript(r?.text);
    },
  };
}
