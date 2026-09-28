import { createSpeechEngine } from './speechEngine.js';
import { attachWorker } from './speechWorkerCore.js';

const port = process.parentPort;
const post = (m) => port.postMessage(m);
const engine = createSpeechEngine({
  voice: process.env.JARVIS_VOICE || 'af_heart',
  asrModel: process.env.JARVIS_ASR_MODEL || 'onnx-community/whisper-base.en',
  cacheDir: process.env.JARVIS_MODELS_DIR,
  onProgress: (percent) => post({ type: 'progress', percent }),
});
engine.ready.then(() => post({ type: 'ready' }), (e) => post({ type: 'failed', message: e.message }));

attachWorker(port, engine);
