// Conversation flow + face state machine. Pure logic: all I/O comes in through `deps`.
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'affirmative', 'proceed', 'confirm']);
const NO = new Set(['no', 'nope', 'nah', 'cancel', 'stop', 'dont', 'negative', 'abort']);
const FILLER = /^(\[.*\]|\(.*\)|thank you[.!]?|thanks( for watching)?[.!]?|bye[.!]?|you\.?|\.{1,3})$/i;

export function parseYesNo(text) {
  const normalized = String(text ?? '').toLowerCase().replace(/'/g, '').replace(/[^a-z\s]/g, ' ');
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.some((w) => NO.has(w))) return false;
  if (/\bdo it\b/.test(normalized) || /\bgo ahead\b/.test(normalized)) return true;
  if (words.some((w) => YES.has(w))) return true;
  return null;
}

function cleanTranscript(text) {
  const t = String(text ?? '').trim();
  return FILLER.test(t) ? '' : t;
}

export function createController({ face, ui, core, speech, mic, chime = () => {}, timers = globalThis, config = {} }) {
  const listenMs = config.listenTimeoutMs ?? 6000;
  const maxMs = config.maxUtteranceMs ?? 10000;
  let state = 'idle';
  let muted = false;
  let token = 0;          // every new flow bumps this; stale flows stop at their next check
  let typedWaiter = null; // set while listening, receives typed/Wispr text
  let watchdogId = null;  // tracks pending watchdog timer
  let watchdogToken = 0;  // token at watchdog start, to check if flow is still current
  let pendingAsk = false; // true while an ask's question is being spoken or its answer is being listened for
  let voiceFlow = null;   // { listened, discarded } describes the in-flight user-triggered command capture (trigger())
  let pendingDoneMsg = null; // a 'done' that arrived during voiceFlow, spoken once the listen settles (or dropped)
  let coreDownCooldown = false; // true for 10s after "My core stopped." was last spoken, to avoid repeating it
  let typingAbandonId = null; // idle timer while waiting for a typed submit after onTypingStarted discarded the voice flow
  let sayQueue = [];       // agent-say texts waiting to be spoken while idle
  let flushingSay = false; // guards against re-entrant flushSayQueue loops
  let watchdogSeq = 0;     // bumped every time a watchdog is (re-)armed, to invalidate a stale armed timer
  let restarting = false;  // true from core-restarting until core-restarted/core-down/fatal; drops stale done/ask from the dead core

  const set = (s) => { state = s; face.setState(s); };
  const rest = () => { set(muted ? 'muted' : 'idle'); flushSayQueue(); };

  function clearWatchdog() {
    if (watchdogId) {
      timers.clearTimeout?.(watchdogId);
      watchdogId = null;
    }
  }

  // Re-arms the 90s "still working" watchdog (used by submit() and refreshed by agent-progress).
  function armWatchdog() {
    clearWatchdog();
    const mySeq = ++watchdogSeq;
    watchdogToken = token;
    watchdogId = timers.setTimeout(async () => {
      if (watchdogSeq !== mySeq || token !== watchdogToken) return;
      set('error');
      await say("That's taking too long.");
      if (watchdogSeq === mySeq && token === watchdogToken) rest();
    }, 90000);
  }

  // Speaks queued agent-say texts, one at a time, once nothing else has a claim on the face.
  function flushSayQueue() {
    if (flushingSay) return;
    if (state !== 'idle' || voiceFlow || pendingAsk || sayQueue.length === 0) return;
    flushingSay = true;
    const my = token;
    (async () => {
      while (sayQueue.length && token === my) {
        const text = sayQueue.shift();
        await say(text);
        if (token !== my) break;
      }
      flushingSay = false;
      if (token === my) rest();
    })();
  }

  async function say(text) {
    if (!text) return;
    set('speaking');
    ui.setStatus(text);
    try { await speech.speak(text); } catch (e) { ui.showError(`Voice unavailable: ${e.message}`); }
  }

  // Resolves { text } (typed), { pcm } (speech) or null (silence / cancelled).
  function listen() {
    set('listening');
    chime();
    ui.focusInput();
    return new Promise((resolve) => {
      let finished = false;
      const finish = (v) => { if (finished) return; finished = true; typedWaiter = null; resolve(v); };
      typedWaiter = (text) => { finish({ text }); mic.cancel(); };
      mic.startUtterance({ noSpeechMs: listenMs, maxMs }).then((pcm) => finish(pcm ? { pcm } : null), () => finish(null));
    });
  }

  async function toText(heard, flowToken, { grace = 0, flow = null } = {}) {
    if (!heard) return null;
    if (heard.text != null) return heard.text.trim();
    if (flowToken && flowToken !== token) return null; // flow was cancelled
    set('thinking');
    if (flowToken && flowToken !== token) return null; // cancelled while setting state
    if (grace) {
      // Give a typed (Wispr) submission a short head start over the voice transcript.
      await new Promise((resolve) => timers.setTimeout(resolve, grace));
      if ((flowToken && flowToken !== token) || flow?.discarded) return null;
    }
    try {
      const text = cleanTranscript(await speech.transcribe(heard.pcm));
      return flow?.discarded ? null : text;
    } catch (e) { ui.showError(`I couldn't transcribe that: ${e.message}`); return ''; }
  }

  async function submit(text) {
    set('thinking');
    ui.setStatus(`"${text}"`);
    armWatchdog();
    try { await core.send(text); } catch (e) { set('error'); ui.showError(e.message); timers.setTimeout(rest, 1500); }
  }

  // Speaks (or drops) a 'done' that arrived while a user command listen was in flight, once
  // that listen settles without sending a new command; otherwise just returns to idle/muted.
  function settleIdle() {
    if (pendingDoneMsg) {
      const msg = pendingDoneMsg;
      pendingDoneMsg = null;
      return onDone(msg);
    }
    return rest();
  }

  async function trigger() {
    if (muted || state === 'listening' || state === 'thinking' || state === 'preparing') return;
    if (pendingAsk) { speech.stop(); return; } // barge-in on a pending question: stop speech, let onAsk's own listen continue
    const my = ++token;
    if (state === 'speaking') speech.stop();
    const flow = { listened: false, discarded: false };
    voiceFlow = flow;
    const heard = await listen();
    flow.listened = true;
    const text = await toText(heard, my, { grace: 1500, flow });
    voiceFlow = null;
    if (my !== token || flow.discarded) return;
    if (text === null) return settleIdle();
    if (text === '') {
      await say("I didn't catch that.");
      if (my !== token) return;
      return settleIdle();
    }
    pendingDoneMsg = null; // a new command supersedes any stale queued reply
    await submit(text);
  }

  async function onAsk(msg) {
    const my = ++token;
    pendingAsk = true;
    await say(msg.question);
    if (my !== token) { pendingAsk = false; return core.answer(msg.id, null); }
    const text = await toText(await listen(), my);
    pendingAsk = false;
    if (my !== token) return core.answer(msg.id, null);
    core.answer(msg.id, msg.kind === 'text' ? (text || null) : (text ? parseYesNo(text) : null));
    set('thinking');
  }

  async function onDone(msg) {
    const my = ++token;
    await say(msg.say);
    if (my === token) rest();
  }

  function onEvent(evt) {
    switch (evt?.type) {
      case 'state': if (evt.state === 'thinking' && state === 'idle') set('thinking'); break;
      case 'ask':
        if (restarting) { core.answer(evt.id, null); break; } // stale question from the dead core
        clearWatchdog(); onAsk(evt); break;
      case 'agent-ask':
        if (restarting) { core.answer(evt.id, null); break; } // stale question from the dead core
        clearWatchdog(); onAsk(evt); break;
      case 'agent-say': sayQueue.push(evt.text); flushSayQueue(); break;
      case 'agent-progress': if (watchdogId && state === 'thinking') armWatchdog(); break;
      case 'done':
        clearWatchdog();
        if (restarting) break; // stale reply from the dead core; the restart path already spoke
        if (voiceFlow) { pendingDoneMsg = evt; break; } // a user listen is active: don't hijack the face
        onDone(evt);
        break;
      case 'hotkey': trigger(); break;
      case 'mute':
        clearWatchdog();
        pendingDoneMsg = null;
        muted = !!evt.muted; token++;
        mic.setMuted?.(muted);
        if (muted) { mic.cancel(); speech.stop(); }
        rest();
        break;
      case 'core-restarting': clearWatchdog(); pendingDoneMsg = null; restarting = true; token++; set('error'); ui.showError('My core hit a problem — restarting…'); mic.cancel(); break;
      case 'core-restarted': { pendingDoneMsg = null; restarting = false; const my = ++token; say("I had a hiccup, but I'm back.").then(() => { if (my === token) rest(); }); break; }
      case 'core-down': case 'fatal': {
        clearWatchdog();
        pendingDoneMsg = null;
        restarting = false;
        token++;
        set('error');
        ui.showError(evt.message ?? 'My core stopped.');
        if (!coreDownCooldown) {
          coreDownCooldown = true;
          timers.setTimeout(() => { coreDownCooldown = false; }, 10000);
          const my = token;
          say('My core stopped.').then(() => { if (token === my) set('error'); });
        }
        break;
      }
      case 'speech-progress': if (state === 'idle' || state === 'preparing') set('preparing'); ui.setStatus(`Preparing voice… ${evt.percent}%`); break;
      case 'speech-ready': ui.setStatus(''); if (state === 'preparing') rest(); break;
      case 'speech-down': ui.showError('Voice unavailable — you can still type.'); if (state === 'preparing') rest(); break;
      case 'warning': case 'display-warning': ui.setStatus(evt.message); break;
    }
  }

  return {
    trigger,
    onEvent,
    onTypingStarted() {
      // Fires on the first keystroke of a fresh typed/Wispr entry. If a user command listen has
      // already captured speech (or is transcribing it), that voice result must be dropped —
      // the typed text, once submitted via onTyped, becomes the command instead. If the user
      // then abandons typing (no Enter/auto-send), a 15s idle timer returns the face to idle
      // instead of leaving it stuck in 'thinking' forever.
      if (voiceFlow && voiceFlow.listened) {
        voiceFlow.discarded = true;
        mic.cancel();
        if (typingAbandonId) { timers.clearTimeout?.(typingAbandonId); typingAbandonId = null; }
        const waiter = (t) => {
          if (typedWaiter !== waiter) return;
          typedWaiter = null;
          if (typingAbandonId) { timers.clearTimeout?.(typingAbandonId); typingAbandonId = null; }
          submit(t);
        };
        typedWaiter = waiter;
        const armedToken = token;
        typingAbandonId = timers.setTimeout(() => {
          typingAbandonId = null;
          if (typedWaiter === waiter && token === armedToken) { typedWaiter = null; rest(); }
        }, 15000);
      }
    },
    onTyped(text) {
      const t = String(text ?? '').trim();
      if (!t) return;
      if (typedWaiter) typedWaiter(t);
      else if (state === 'thinking') submit(t);
      else if (state === 'speaking') { token++; speech.stop(); submit(t); }
      else if (state === 'idle' || state === 'muted' || state === 'preparing' || state === 'error') submit(t);
    },
    get state() { return state; },
  };
}
