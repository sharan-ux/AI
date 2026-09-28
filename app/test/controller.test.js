import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createController, parseYesNo } from '../renderer/controller.js';

function harness(opts = {}) {
  const log = { states: [], said: [], sent: [], answers: [], chimes: 0, focus: 0, errors: [] };
  let micResolve = null;
  let speakResolve = null;
  const transcripts = [...(opts.transcripts ?? ['open teams'])];
  const mic = {
    startUtterance: () => new Promise((r) => { micResolve = r; }),
    cancel() { if (micResolve) { const r = micResolve; micResolve = null; r(null); } },
    setMuted() {},
  };
  const speech = {
    speak: (t) => { log.said.push(t); return opts.holdSpeech ? new Promise((r) => { speakResolve = r; }) : Promise.resolve(); },
    stop: () => { if (speakResolve) { const r = speakResolve; speakResolve = null; r(); } },
    transcribe: async () => transcripts.shift() ?? '',
  };
  const pending = [];
  let timerCounter = 0;
  const timers = opts.manualTimers ? {
    setTimeout(f, ms) { pending.push({ f, ms }); return pending.length; },
    clearTimeout(id) { if (id && id > 0 && id <= pending.length) pending[id - 1] = null; },
  } : {
    setTimeout(f, ms) { timerCounter++; if (!ms || ms < 90000) f(); return timerCounter; },
    clearTimeout(id) { /* noop for non-manual */ },
  };
  const c = createController({
    face: { setState: (s) => log.states.push(s) },
    ui: { focusInput: () => { log.focus++; }, setStatus() {}, showError: (e) => log.errors.push(e) },
    core: { send: async (t) => { log.sent.push(t); return 'c1'; }, answer: (id, v) => log.answers.push([id, v]) },
    speech, mic, chime: () => { log.chimes++; },
    timers,
    config: { listenTimeoutMs: 6000, maxUtteranceMs: 10000 },
  });
  return {
    c, log, pending,
    hear: () => { const r = micResolve; micResolve = null; if (r) r(new Float32Array(1600)); },
    silence: () => { const r = micResolve; micResolve = null; if (r) r(null); },
    finishSpeech: () => speech.stop(),
    fireGrace: () => { if (pending[0] && pending[0].f) pending[0].f(); }, // the 1500ms post-mic grace timer (always scheduled first)
    fireWatchdog: () => { if (pending[1] && pending[1].f) pending[1].f(); }, // the 90s watchdog (scheduled after the grace timer, once submit() runs)
  };
}
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test('wake → listen → transcribe → send → done → speak → idle', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'listening');
  assert.equal(h.log.chimes, 1);
  assert.equal(h.log.focus, 1);
  h.hear(); await flush();
  assert.deepEqual(h.log.sent, ['open teams']);
  assert.equal(h.c.state, 'thinking');
  h.c.onEvent({ type: 'done', id: 'c1', outcome: 'executed', say: 'Opening Teams.' }); await flush();
  assert.deepEqual(h.log.said, ['Opening Teams.']);
  assert.equal(h.c.state, 'idle');
});

test('typed (Wispr) text while listening wins over the microphone', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  h.c.onTyped('start my day'); await flush();
  assert.deepEqual(h.log.sent, ['start my day']);
});

test('typing while idle sends directly', async () => {
  const h = harness();
  h.c.onTyped('agentic dev'); await flush();
  assert.deepEqual(h.log.sent, ['agentic dev']);
});

test('silence returns to idle without sending', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  h.silence(); await flush();
  assert.deepEqual(h.log.sent, []);
  assert.equal(h.c.state, 'idle');
});

test('an empty or filler transcript is "didn\'t catch that"', async () => {
  for (const t of ['', '[BLANK_AUDIO]', '(silence)', ' Thank you. ']) {
    const h = harness({ transcripts: [t] });
    h.c.trigger(); await flush(); h.hear(); await flush();
    assert.deepEqual(h.log.sent, [], `sent for "${t}"`);
    assert.deepEqual(h.log.said, ["I didn't catch that."]);
    assert.equal(h.c.state, 'idle');
  }
});

test('a question is spoken and answered by voice', async () => {
  const h = harness({ transcripts: ['yes please'] });
  h.c.onEvent({ type: 'ask', id: 'q1', question: 'Open Notepad. Proceed?' }); await flush();
  assert.deepEqual(h.log.said, ['Open Notepad. Proceed?']);
  assert.equal(h.c.state, 'listening');
  h.hear(); await flush();
  assert.deepEqual(h.log.answers, [['q1', true]]);
});

test('silence to a question answers null', async () => {
  const h = harness();
  h.c.onEvent({ type: 'ask', id: 'q1', question: 'Proceed?' }); await flush();
  h.silence(); await flush();
  assert.deepEqual(h.log.answers, [['q1', null]]);
});

test('barge-in: the hotkey while speaking stops speech and keeps listening', async () => {
  const h = harness({ holdSpeech: true });
  h.c.onEvent({ type: 'done', id: 'c1', outcome: 'executed', say: 'Opening Teams.' }); await flush();
  assert.equal(h.c.state, 'speaking');
  h.c.onEvent({ type: 'hotkey' }); await flush();
  assert.equal(h.c.state, 'listening');
  await flush();
  assert.equal(h.c.state, 'listening');
});

test('muted ignores triggers', async () => {
  const h = harness();
  h.c.onEvent({ type: 'mute', muted: true }); await flush();
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'muted');
  assert.equal(h.log.chimes, 0);
});

test('core down shows the error and says so', async () => {
  const h = harness({ holdSpeech: true });
  h.c.onEvent({ type: 'core-down' }); await flush();
  assert.ok(h.log.states.includes('error'));
  assert.deepEqual(h.log.said, ['My core stopped.']);
});

test('parseYesNo', () => {
  assert.equal(parseYesNo('yes please'), true);
  assert.equal(parseYesNo('Yeah, do it.'), true);
  assert.equal(parseYesNo('sure'), true);
  assert.equal(parseYesNo('no'), false);
  assert.equal(parseYesNo("no, don't"), false);
  assert.equal(parseYesNo("please don't"), false);
  assert.equal(parseYesNo('cancel that'), false);
  assert.equal(parseYesNo('what was that'), null);
  assert.equal(parseYesNo(''), null);
  assert.equal(parseYesNo('please repeat that'), null);
  assert.equal(parseYesNo('do you mean teams'), null);
  assert.equal(parseYesNo('do it'), true);
  assert.equal(parseYesNo("don't do it"), false);
  assert.equal(parseYesNo("no, don't do it"), false);
  assert.equal(parseYesNo("yeah don't do it"), false);
});

test('watchdog: no reply within 90 seconds says "taking too long"', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  h.hear(); await flush();
  h.fireGrace(); await flush(); // grace period elapses; the transcript is sent
  assert.deepEqual(h.log.sent, ['open teams']);
  assert.equal(h.c.state, 'thinking');
  h.fireWatchdog(); await flush();
  assert.deepEqual(h.log.said, ["That's taking too long."]);
  assert.equal(h.c.state, 'idle');
});

test('watchdog: done before timeout clears it', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  h.hear(); await flush();
  h.fireGrace(); await flush(); // grace period elapses; the transcript is sent
  assert.equal(h.c.state, 'thinking');
  h.c.onEvent({ type: 'done', id: 'c1', outcome: 'executed', say: 'Done.' }); await flush();
  h.fireWatchdog(); await flush(); // watchdog was cleared by the done — firing it must be a no-op
  assert.deepEqual(h.log.said, ['Done.']);
  assert.equal(h.c.state, 'idle');
});

test('typing while thinking sends the text', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  h.hear(); await flush();
  assert.equal(h.c.state, 'thinking');
  h.c.onTyped('new command'); await flush();
  assert.deepEqual(h.log.sent, ['open teams', 'new command']);
});

test('typing while speaking stops speech and sends', async () => {
  const h = harness({ holdSpeech: true });
  h.c.onEvent({ type: 'done', id: 'c1', outcome: 'executed', say: 'Speaking.' }); await flush();
  assert.equal(h.c.state, 'speaking');
  h.c.onTyped('interrupt'); await flush();
  assert.equal(h.c.state, 'thinking');
  assert.deepEqual(h.log.sent, ['interrupt']);
});

test('core-restarting increments token so pending flows abort', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'listening');
  h.c.onEvent({ type: 'core-restarting' }); await flush();
  h.hear(); await flush();
  assert.deepEqual(h.log.sent, [], 'flow was cancelled');
  assert.equal(h.c.state, 'error');
});

// --- item 1: hotkey + Wispr double-send -------------------------------------------------

test('typing during the post-mic grace period wins; the voice transcript is dropped (no double send)', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'listening');
  h.hear(); await flush(); // mic ends with speech; controller enters the grace period
  h.c.onTypingStarted(); await flush();
  h.c.onTyped('open teams'); await flush();
  assert.deepEqual(h.log.sent, ['open teams']);
  // letting the grace timer (and any leftover transcription) fire must not add a second send
  for (const t of h.pending) t?.f?.();
  await flush();
  assert.deepEqual(h.log.sent, ['open teams']);
});

test('with no typing, the voice path still sends after the grace period elapses', async () => {
  const h = harness({ manualTimers: true, transcripts: ['open teams'] });
  h.c.trigger(); await flush();
  h.hear(); await flush();
  assert.deepEqual(h.log.sent, [], 'not sent yet — still inside the grace period');
  h.pending[0].f(); await flush(); // grace period elapses
  assert.deepEqual(h.log.sent, ['open teams']);
});

test('onTypingStarted without a following onTyped eventually rests instead of sticking in thinking forever', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  h.hear(); await flush(); // mic ends with speech; controller enters the grace period
  h.c.onTypingStarted(); await flush();
  assert.equal(h.c.state, 'thinking');
  const abandon = h.pending.find((p) => p && p.ms === 15000);
  assert.ok(abandon, 'expected a 15s abandon timer to be scheduled');
  abandon.f(); await flush(); // the user never finished typing/submitting
  assert.equal(h.c.state, 'idle');
  assert.deepEqual(h.log.sent, []);
});

test('onTyped before the abandon timer fires sends exactly once and the timer is cleared', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  h.hear(); await flush();
  h.c.onTypingStarted(); await flush();
  h.c.onTyped('open teams'); await flush();
  assert.deepEqual(h.log.sent, ['open teams']);
  // the abandon timer was cleared by the typed submit; firing any leftover (non-watchdog) timers
  // must not double-send
  for (const t of h.pending) { if (t && t.ms !== 90000) t.f(); }
  await flush();
  assert.deepEqual(h.log.sent, ['open teams']);
});

// --- item 3: barge-in on a pending ask must not lose the answer -------------------------

test('barge-in (hotkey) while a question is being spoken does not start a new listen and keeps the answer flow', async () => {
  const h = harness({ holdSpeech: true, transcripts: ['yes'] });
  h.c.onEvent({ type: 'ask', id: 'q1', question: 'Proceed?' }); await flush();
  assert.equal(h.c.state, 'speaking');
  h.c.onEvent({ type: 'hotkey' }); await flush(); // barge-in: stop speech, let onAsk continue
  assert.equal(h.c.state, 'listening');
  h.hear(); await flush();
  assert.deepEqual(h.log.answers, [['q1', true]]);
  assert.deepEqual(h.log.sent, [], 'no new command listen was started');
});

test('a done arriving during an active user listen does not hijack the face; the listen still sends its command', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'listening');
  h.c.onEvent({ type: 'done', id: 'c0', outcome: 'executed', say: 'Earlier reply.' }); await flush();
  assert.equal(h.c.state, 'listening', 'the done must not take over the face');
  assert.deepEqual(h.log.said, [], 'the stale reply is not spoken yet');
  h.hear(); await flush();
  assert.deepEqual(h.log.sent, ['open teams'], 'the listen completed and sent its own command');
});

test('a done arriving during silence (no new command sent) is spoken once the listen finishes', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  h.c.onEvent({ type: 'done', id: 'c0', outcome: 'executed', say: 'Earlier reply.' }); await flush();
  h.silence(); await flush();
  assert.deepEqual(h.log.said, ['Earlier reply.']);
  assert.equal(h.c.state, 'idle');
});

test('a queued done is dropped on mute and never spoken by a later, unrelated listen', async () => {
  const h = harness();
  h.c.trigger(); await flush();
  assert.equal(h.c.state, 'listening');
  h.c.onEvent({ type: 'done', id: 'c0', outcome: 'executed', say: 'Stale reply.' }); await flush();
  h.c.onEvent({ type: 'mute', muted: true }); await flush();
  h.c.onEvent({ type: 'mute', muted: false }); await flush();
  h.c.trigger(); await flush();
  h.silence(); await flush();
  assert.deepEqual(h.log.said, [], 'the stale done must not be spoken');
  assert.equal(h.c.state, 'idle');
});

// --- item 6: core-down/fatal ends in error, and only speaks once per 10s burst ----------

test('core-down ends the face in error (not speaking), and does not repeat within 10s', async () => {
  const h = harness({ manualTimers: true });
  h.c.onEvent({ type: 'core-down' }); await flush();
  assert.deepEqual(h.log.said, ['My core stopped.']);
  assert.equal(h.c.state, 'error');
  h.c.onEvent({ type: 'core-down' }); await flush();
  assert.deepEqual(h.log.said, ['My core stopped.'], 'no repeat within the 10s burst window');
  h.pending[0].f(); // the 10s cooldown elapses
  h.c.onEvent({ type: 'core-down' }); await flush();
  assert.deepEqual(h.log.said, ['My core stopped.', 'My core stopped.']);
  assert.equal(h.c.state, 'error');
});

// --- item 7: parseYesNo additions --------------------------------------------------------

test('parseYesNo recognizes proceed/confirm/go ahead as yes and abort as no', () => {
  assert.equal(parseYesNo('proceed'), true);
  assert.equal(parseYesNo('confirm'), true);
  assert.equal(parseYesNo('go ahead'), true);
  assert.equal(parseYesNo('abort'), false);
});

// --- item 8: additional Whisper filler phrases ------------------------------------------

test('additional Whisper filler phrases are treated as "didn\'t catch that"', async () => {
  for (const t of ['Thank you!', 'Thanks for watching!', 'Bye.', 'Bye!', '.', '...']) {
    const h = harness({ transcripts: [t] });
    h.c.trigger(); await flush(); h.hear(); await flush();
    assert.deepEqual(h.log.sent, [], `sent for "${t}"`);
    assert.deepEqual(h.log.said, ["I didn't catch that."], `said for "${t}"`);
  }
});

// --- Task 9: manager-agent events (agent-say / agent-ask / agent-progress) ---------------

test('agent-say is spoken when idle and queued while busy', async () => {
  const h = harness();
  h.c.onEvent({ type: 'agent-say', text: 'PAY-142 is done.' }); await flush();
  assert.deepEqual(h.log.said, ['PAY-142 is done.']);
  h.c.trigger(); await flush();
  h.c.onEvent({ type: 'agent-say', text: 'WEB-150 needs you.' }); await flush();
  assert.equal(h.log.said.length, 1, 'not spoken over a listen');
  h.silence(); await flush();
  assert.deepEqual(h.log.said.at(-1), 'WEB-150 needs you.');
});

test('agent-ask confirm uses yes/no; text returns the transcript', async () => {
  const h = harness({ transcripts: ['yes please', 'payments api'] });
  h.c.onEvent({ type: 'agent-ask', id: 'a1', question: 'Push branch izza/PAY-142?', kind: 'confirm' }); await flush();
  h.hear(); await flush();
  h.c.onEvent({ type: 'agent-ask', id: 'a2', question: 'Which folder is the PAY project in?', kind: 'text' }); await flush();
  h.hear(); await flush();
  assert.deepEqual(h.log.answers, [['a1', true], ['a2', 'payments api']]);
});

test('agent-progress keeps a long manager turn alive past the watchdog', async () => {
  const h = harness({ manualTimers: true });
  h.c.onTyped('look at PAY-142'); await flush();
  const first = h.pending.find((p) => p && p.ms === 90000);
  h.c.onEvent({ type: 'agent-progress' }); await flush();
  first.f(); await flush();
  assert.ok(!h.log.said.includes("That's taking too long."), 'the old watchdog was replaced');
  assert.equal(h.c.state, 'thinking');
});

test('abandon timer does not overwrite an error set after it was armed', async () => {
  const h = harness({ manualTimers: true });
  h.c.trigger(); await flush();
  h.hear(); await flush();
  h.c.onTypingStarted(); await flush();
  h.c.onEvent({ type: 'core-restarting' }); await flush();
  h.pending.filter((p) => p && p.ms === 15000).forEach((p) => p.f()); await flush();
  assert.equal(h.c.state, 'error');
});

test('a done queued during a listen is dropped on core-restarted', async () => {
  const h = harness({ holdSpeech: false });
  h.c.trigger(); await flush();
  h.c.onEvent({ type: 'core-restarting' }); await flush();
  h.c.onEvent({ type: 'done', id: 'c1', outcome: 'executed', say: 'Stale after restart.' }); await flush();
  h.silence(); await flush();
  h.c.onEvent({ type: 'core-restarted' }); await flush();
  h.c.trigger(); await flush();
  h.silence(); await flush();
  assert.ok(!h.log.said.includes('Stale after restart.'));
});

test('a done arriving after core-restarted (the new core\'s reply) is spoken normally', async () => {
  const h = harness();
  h.c.onEvent({ type: 'core-restarting' }); await flush();
  h.c.onEvent({ type: 'core-restarted' }); await flush();
  h.c.onEvent({ type: 'done', id: 'c2', outcome: 'executed', say: 'New core is back.' }); await flush();
  assert.ok(h.log.said.includes('New core is back.'));
});

test('agent-say is not spoken while muted; it is spoken after unmute', async () => {
  const h = harness();
  h.c.onEvent({ type: 'mute', muted: true }); await flush();
  h.c.onEvent({ type: 'agent-say', text: 'PAY-142 is done.' }); await flush();
  assert.deepEqual(h.log.said, [], 'not spoken while muted');
  h.c.onEvent({ type: 'mute', muted: false }); await flush();
  assert.deepEqual(h.log.said, ['PAY-142 is done.']);
});
