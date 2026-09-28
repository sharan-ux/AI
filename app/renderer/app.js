import { createController } from './controller.js';
import { createFace } from './face.js';
import { createMic } from './mic.js';
import { createPlayer } from './player.js';
import { createSpeechOut } from './speechOut.js';
import { createUI } from './ui.js';
import { createWake } from './wake.js';

const bridge = window.jarvis;
const face = await createFace(document.getElementById('c'));
const cfg = await bridge.config();
const player = createPlayer({ onAmplitude: (a) => face.setAmplitude(a) });
const speechOut = createSpeechOut({ synth: (text) => bridge.speak(text), player });

let mic = null, wake = null;
const nullMic = { startUtterance: async () => null, cancel() {}, async setMuted() {} };

let controller;
const ui = createUI({ onSubmit: (text) => controller.onTyped(text), onTypingStarted: () => controller.onTypingStarted() });

controller = createController({
  face, ui,
  core: { send: (text) => bridge.command(text), answer: (id, value) => bridge.answer(id, value) },
  speech: {
    speak: (text) => speechOut.speak(text),
    stop: () => speechOut.stop(),
    transcribe: (pcm) => bridge.transcribe(pcm),
  },
  mic: {
    startUtterance: (o) => (mic ?? nullMic).startUtterance(o),
    cancel: () => (mic ?? nullMic).cancel(),
    setMuted: async (m) => { await (mic ?? nullMic).setMuted(m); await wake?.setMuted(m); },
  },
  chime: () => player.chime(),
  timers: window,
  config: cfg.voice,
});

bridge.onEvent((evt) => controller.onEvent(evt));
document.getElementById('c').addEventListener('click', () => { if (!document.getElementById('cmd').value.trim()) controller.trigger(); });

if (!cfg.muted) {
  try {
    mic = await createMic();
  } catch (e) {
    ui.showError(`No microphone: ${e.message}. You can still type.`);
  }
}
let wakeUnavailableMessage = null;
if (mic && cfg.picovoiceKey) {
  let modelReady = false;
  try {
    const res = await fetch('/' + cfg.voice.wakeWordModel, { method: 'HEAD' });
    modelReady = res.ok;
  } catch { /* treat a failed fetch as a missing model */ }
  if (modelReady) {
    try {
      wake = await createWake({ accessKey: cfg.picovoiceKey, wakeWordModel: cfg.voice.wakeWordModel, onWake: () => controller.trigger(), onError: (e) => ui.showError(`Wake word: ${e.message}`) });
    } catch (e) {
      ui.showError(`Wake word off: ${e.message}`);
    }
  } else {
    wakeUnavailableMessage = `Add ${cfg.voice.wakeWordModel} from Picovoice Console to enable “Hey Izza”.`;
  }
}
ui.setStatus(wake ? 'Say “Hey Izza”, or press Ctrl+Alt+J' : (wakeUnavailableMessage ?? 'Press Ctrl+Alt+J (or click me), then speak — or use Wispr / type'));
bridge.ready();
