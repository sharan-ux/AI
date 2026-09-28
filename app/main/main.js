import { app, BrowserWindow, Menu, Tray, globalShortcut, ipcMain, nativeImage, net, protocol, screen, session, utilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CoreClient } from './coreClient.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, '..');
const ROOT = path.resolve(APP_DIR, '..');
const SMOKE = process.argv.includes('--smoke');
const ICON = path.join(APP_DIR, 'assets', 'tray.png');
const DEFAULTS = {
  face: { display: 0, fullscreen: true },
  voice: { voice: 'af_heart', wakeWord: 'hey izza', wakeWordModel: 'assets/hey-izza.ppn', listenTimeoutMs: 6000, maxUtteranceMs: 10000, asrModel: 'onnx-community/whisper-base.en' },
};
const SPEECH_ENV_KEYS = new Set(['PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA', 'USERPROFILE']);

// The speech worker only needs enough of the environment to run Node and cache models — never
// API keys or other secrets that might be sitting in the parent process's environment. Takes
// the environment explicitly (rather than reading process.env itself) so it stays pure/testable.
export function filterSpeechWorkerEnv(sourceEnv) {
  const env = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (SPEECH_ENV_KEYS.has(key.toUpperCase()) || key.startsWith('JARVIS_')) env[key] = value;
  }
  return env;
}
function speechWorkerEnv() {
  return filterSpeechWorkerEnv(process.env);
}

// Pure timeout duration for a speechCall() op: transcription can legitimately take longer than
// a short spoken reply, so cap them differently. Kept dependency-free so it can be unit-tested.
export function speechCallTimeoutMs(op) {
  return op === 'transcribe' ? 30000 : 20000;
}

// Pure decision for how to react to a core 'ready' message. Kept dependency-free (no Electron
// imports) so it can be unit-tested in isolation.
//   'open'                  — first ready, no window yet: open it now.
//   'apply-fallback-settings' — window was already opened by the slow-core fallback timer;
//                              this is the first real ready, so move/resize the window and
//                              start the speech worker instead of announcing a restart.
//   'restarted'              — window already showing real settings; a later ready means the
//                              core process actually restarted.
export function decideOnReady({ windowOpened, awaitingFirstReady }) {
  if (!windowOpened) return 'open';
  if (awaitingFirstReady) return 'apply-fallback-settings';
  return 'restarted';
}

// Pure decision for whether a crashed renderer should be reloaded, capping reloads at
// `maxReloads` within any `windowMs` window (mirrors CoreClient's own restart bookkeeping).
// `timestamps` is the crash-time history kept so far; returns whether to reload and the
// pruned/updated history to keep for next time.
export function decideReload(timestamps, now, { maxReloads = 3, windowMs = 60000 } = {}) {
  const recent = timestamps.filter((t) => now - t < windowMs);
  if (recent.length >= maxReloads) return { reload: false, timestamps: recent };
  return { reload: true, timestamps: [...recent, now] };
}

app.setName('jarvis');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0); // stop here: never spawn a second core or open a second window
}

let win = null, tray = null, speech = null;
let settings = DEFAULTS, windowOpened = false, rendererReady = false, muted = false, quitting = false;
let awaitingFirstReady = false; // true once the window was opened by the slow-core fallback timer
let rendererCrashes = []; // timestamps of recent render-process-gone reloads, for decideReload()
let seq = 0, speechRestarts = 0;
const queued = [];
const pendingSpeech = new Map();

function send(evt) {
  if (win && !win.isDestroyed() && rendererReady) win.webContents.send('jarvis:event', evt);
  else queued.push(evt);
}

// ---------- core ----------
const core = new CoreClient({
  spawn: () => spawn(process.env.JARVIS_NODE || 'node',
    ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'bin', 'jarvis-serve.ts')],
    { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }),
});
core.on('message', (m) => {
  if (m.type === 'ready') {
    settings = { face: { ...DEFAULTS.face, ...m.face }, voice: { ...DEFAULTS.voice, ...m.voice } };
    const action = decideOnReady({ windowOpened, awaitingFirstReady });
    if (action === 'open') {
      openWindow();
    } else if (action === 'apply-fallback-settings') {
      awaitingFirstReady = false;
      applySettingsToWindow();
      if (!SMOKE) startSpeech();
    } else {
      send({ type: 'core-restarted' });
    }
    return;
  }
  if (m.type === 'fatal' && !windowOpened) openWindow();
  send(m);
});
core.on('restarting', () => send({ type: 'core-restarting' }));
core.on('down', () => send({ type: 'core-down' }));
core.on('log', (text) => process.stderr.write(`[core] ${text}`));

// ---------- speech worker ----------
function startSpeech() {
  speech = utilityProcess.fork(path.join(HERE, 'speechWorker.js'), [], {
    serviceName: 'jarvis-speech',
    env: {
      ...speechWorkerEnv(),
      JARVIS_MODELS_DIR: path.join(app.getPath('userData'), 'models'),
      JARVIS_VOICE: settings.voice.voice,
      JARVIS_ASR_MODEL: settings.voice.asrModel,
    },
  });
  speech.on('message', (m) => {
    if (m.type === 'progress') return send({ type: 'speech-progress', percent: m.percent });
    if (m.type === 'ready') return send({ type: 'speech-ready' });
    if (m.type === 'failed') return send({ type: 'speech-down', message: m.message });
    const p = pendingSpeech.get(m.id);
    if (!p) return;
    pendingSpeech.delete(m.id);
    if (m.ok) p.resolve(m.result); else p.reject(new Error(m.error));
  });
  speech.on('exit', () => {
    for (const p of pendingSpeech.values()) p.reject(new Error('speech worker stopped'));
    pendingSpeech.clear();
    speech = null;
    if (quitting) return;
    if (speechRestarts++ < 1) startSpeech(); else send({ type: 'speech-down' });
  });
}
function speechCall(op, payload) {
  if (!speech) return Promise.reject(new Error('voice unavailable'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingSpeech.delete(id);
      reject(new Error('voice timed out'));
    }, speechCallTimeoutMs(op));
    pendingSpeech.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    speech.postMessage({ id, op, ...payload });
  });
}

// ---------- IPC ----------
ipcMain.handle('jarvis:config', () => ({ voice: settings.voice, muted, picovoiceKey: process.env.PICOVOICE_ACCESS_KEY?.trim() || null }));
ipcMain.handle('jarvis:command', (_e, text) => {
  const id = `c${++seq}`;
  if (!core.send({ type: 'command', id, text: String(text).slice(0, 500) })) throw new Error('my core is not running');
  return id;
});
ipcMain.on('jarvis:answer', (_e, id, value) => {
  const v = typeof value === 'string' ? value.slice(0, 500) : (value === true ? true : value === false ? false : null);
  core.send({ type: 'answer', id: String(id), value: v });
});
ipcMain.handle('jarvis:transcribe', (_e, pcm) => {
  const maxSamples = 16000 * (settings.voice.maxUtteranceMs / 1000 + 2);
  if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > maxSamples) throw new Error('bad audio');
  return speechCall('transcribe', { pcm });
});
ipcMain.handle('jarvis:speak', (_e, text) => speechCall('speak', { text: String(text).slice(0, 400) }));
ipcMain.on('jarvis:renderer-ready', () => {
  rendererReady = true;
  for (const evt of queued.splice(0)) win.webContents.send('jarvis:event', evt);
  if (muted) send({ type: 'mute', muted: true }); // keep a reloaded renderer's mic in sync with the tray
});

// ---------- window, tray, hotkey ----------
function resolveDisplay() {
  let display = screen.getAllDisplays()[settings.face.display];
  let warning = null;
  if (!display) {
    display = screen.getPrimaryDisplay();
    warning = `Display ${settings.face.display} not found — using the primary display.`;
  }
  return { display, warning };
}

// Re-applies the (by-then-real) configured display/fullscreen to a window that was already
// opened by the slow-core fallback timer using DEFAULTS.
function applySettingsToWindow() {
  const { display, warning } = resolveDisplay();
  if (warning) send({ type: 'display-warning', message: warning });
  win.setBounds(display.bounds);
  win.setFullScreen(settings.face.fullscreen && !SMOKE);
}

function openWindow({ fallback = false } = {}) {
  windowOpened = true;
  awaitingFirstReady = fallback;
  const { display, warning } = resolveDisplay();
  if (warning) send({ type: 'display-warning', message: warning });
  const { x, y, width, height } = display.bounds;
  win = new BrowserWindow({
    x, y, width, height,
    fullscreen: settings.face.fullscreen && !SMOKE,
    show: !SMOKE,
    title: 'Izza',
    backgroundColor: '#000208',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(ICON),
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy: 'no-user-gesture-required' },
  });
  win.loadURL('app://jarvis/renderer/index.html');
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });

  // Renderer reload/crash: keep events queueing (send() already falls back to the queue while
  // rendererReady is false) and flush them again once 'jarvis:renderer-ready' fires next.
  win.webContents.on('did-start-loading', () => { rendererReady = false; });
  win.webContents.on('render-process-gone', (_e, details) => {
    rendererReady = false;
    process.stderr.write(`[renderer] render process gone: ${details.reason}\n`);
    if (quitting) return;
    const decision = decideReload(rendererCrashes, Date.now());
    rendererCrashes = decision.timestamps;
    if (decision.reload) {
      win.reload();
    } else {
      tray?.setToolTip('Izza — face crashed (restart the app)');
    }
  });

  // Navigation lock: the face page never needs to open new windows or leave app://jarvis/.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://jarvis/')) e.preventDefault(); });

  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Izza');
  const menu = () => Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide face' : 'Show face', click: () => { win.isVisible() ? win.hide() : win.show(); tray.setContextMenu(menu()); } },
    { label: 'Mute microphone', type: 'checkbox', checked: muted, click: (item) => { muted = item.checked; send({ type: 'mute', muted }); } },
    { type: 'separator' },
    { label: 'Quit Izza', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { win.show(); win.focus(); });

  const hotkeyRegistered = globalShortcut.register('Control+Alt+J', () => { win.show(); win.focus(); send({ type: 'hotkey' }); });
  if (!hotkeyRegistered) send({ type: 'warning', message: 'Ctrl+Alt+J is taken by another app — click the Izza face instead.' });

  if (SMOKE) {
    ipcMain.once('jarvis:renderer-ready', () => { console.log('SMOKE OK'); quitting = true; core.stop(); app.exit(0); });
    setTimeout(() => { console.error('SMOKE FAILED: renderer never became ready'); app.exit(1); }, 30000);
  } else if (!fallback) {
    startSpeech();
  }
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response('bad request', { status: 400 });
    }
    const file = path.normalize(path.join(APP_DIR, pathname));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  core.start();
  setTimeout(() => { if (!windowOpened) openWindow({ fallback: true }); }, 15000);
});

app.on('window-all-closed', () => {});           // stay in the tray
app.on('before-quit', () => { quitting = true; core.stop(); speech?.kill(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('second-instance', () => { win?.show(); win?.focus(); });
