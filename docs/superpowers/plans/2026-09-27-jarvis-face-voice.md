# Jarvis v2 — Face + Voice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Jarvis into an Electron desktop app with the approved glowing face, local wake word ("Jarvis"), local Whisper transcription, Wispr-friendly text box, and a natural local voice (Kokoro *af_heart*), all driving the unchanged v1 core.

**Architecture:** The v1 core gains a JSON-lines `serve` entry (`bin/jarvis-serve.ts`) and a spoken-reply builder. A new `app/` Electron project spawns that core as a child process, runs Whisper + Kokoro in an Electron `utilityProcess`, and renders the face (three.js) in a sandboxed window served over a private `app://` protocol. A pure `controller.js` state machine ties wake word / hotkey / typing / core events / speech together.

**Tech Stack:** Node 24 (core, type-stripped TS, zero deps — unchanged), Electron 44.4.5, three 0.160.0, @picovoice/porcupine-web 4.0.1 + @picovoice/web-voice-processor 4.0.10, kokoro-js 1.2.1, @huggingface/transformers 3.8.1, `node:test`.

**Spec:** `docs/superpowers/specs/2026-09-27-jarvis-face-voice-design.md`

## Global Constraints

- **No git commits** during this build (user instruction: run locally first).
- Core (`src/`, `bin/`, `test/`) stays **zero-dependency** Node 24 TypeScript with erasable-only syntax (`import type`, `.ts` extensions).
- All app code lives under `app/`, which has its own `package.json` with `"type": "module"`; only `app/main/preload.cjs` is CommonJS (required by Electron's sandboxed preload).
- Renderer: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`; no remote scripts; strict CSP (no inline scripts).
- Hotkey is **Ctrl+Alt+J** (never Ctrl+Space — VS Code autocomplete).
- Voice: Kokoro `onnx-community/Kokoro-82M-v1.0-ONNX`, **dtype `fp32`**, voice **`af_heart`**. Transcription: `onnx-community/whisper-base.en`, dtype `fp32`. Models cached in `%APPDATA%\jarvis\models`.
- Spoken replies never contain the word "Jarvis".
- No audio is written to disk; nothing in the app runs actions — everything goes through the core's allowlist.
- Timings from the spec: end-of-speech 900 ms of silence, max utterance 10 000 ms, listen/answer timeout 6 000 ms, Wispr auto-send 1 200 ms after a paste-like input, core restart limit 3 per 60 s, speech worker restart limit 1.

## Review Focus

1. Whisper returns a hallucinated filler for near-silence (e.g. "[BLANK_AUDIO]", "(silence)", "Thank you.") → Jarvis must treat it as "didn't catch that", not run a command (test in Task 6).
2. User says "no, don't" / "please don't" to a confirmation → must be **false**, never true because "please" appears first (test in Task 4).
3. User presses Ctrl+Alt+J while Jarvis is still speaking the previous reply → speech stops and it listens; the old reply's completion must not flip the face back to idle mid-listen (test in Task 4).
4. The core crashes while a command is in flight → the renderer must get a `done` so the face doesn't stay stuck on "thinking" (test in Task 3).
5. Configured display index doesn't exist (monitor unplugged) → window opens on the primary display with a warning instead of off-screen (covered in Task 7 code + manual check in Task 9).

---

### Task 1: Core — command summary, spoken replies, face/voice config

**Files:**
- Modify: `src/core.ts` (return `CommandSummary`)
- Create: `src/spoken.ts`
- Modify: `src/config.ts` (optional `face` and `voice` sections)
- Modify: `jarvis.config.json` (add `face`, `voice`)
- Test: `test/spoken.test.ts`, `test/core.test.ts` (add), `test/config.test.ts` (add)

**Interfaces:**
- Consumes: `handleCommand`, `CoreContext`, `Outcome`, `StepResult`, `Decision`, `validateConfig`.
- Produces:
  - `export interface CommandSummary { decision: Decision; outcome: Outcome | 'none'; results: StepResult[]; errors: string[] }` in `src/core.ts`; `handleCommand(text, ctx): Promise<CommandSummary>`.
  - `spokenReply(summary: CommandSummary): string` in `src/spoken.ts`.
  - `JarvisConfig.face: { display: number; fullscreen: boolean }`, `JarvisConfig.voice: { voice: string; wakeWord: string; listenTimeoutMs: number; maxUtteranceMs: number; asrModel: string }`.

- [ ] **Step 1: Write failing tests `test/spoken.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenReply } from '../src/spoken.ts';
import type { CommandSummary } from '../src/core.ts';

const sum = (over: Partial<CommandSummary> & { intent?: string; target?: string }): CommandSummary => ({
  decision: { intent: (over.intent ?? 'open_app') as any, target: over.target ?? 'teams', confidence: 0.9, source: 'test' },
  outcome: over.outcome ?? 'executed',
  results: over.results ?? [],
  errors: over.errors ?? [],
});

test('executed actions get short confirmations', () => {
  assert.equal(spokenReply(sum({ intent: 'open_app', target: 'teams' })), 'Opening Teams.');
  assert.equal(spokenReply(sum({ intent: 'open_workspace', target: 'agentic' })), 'Opening your agentic workspace.');
  assert.equal(spokenReply(sum({ intent: 'run_routine', target: 'start_day', results: [{ label: 'teams', ok: true }] })), 'Done.');
  assert.equal(spokenReply(sum({ intent: 'remember_fact', target: 'x' })), "Got it, I'll remember that.");
});

test('partly failed routine names each failure', () => {
  const s = sum({ intent: 'run_routine', target: 'start_day', outcome: 'failed', results: [
    { label: 'teams', ok: true },
    { label: 'jira', ok: false, message: 'jira has no URL configured - set apps.jira.url in jarvis.config.json' },
    { label: 'agentic', ok: false, message: 'VS Code not found at C:\\x' },
  ] });
  assert.equal(spokenReply(s), "Done. Jira has no link yet. Agentic didn't open.");
});

test('fully failed action', () => {
  const s = sum({ outcome: 'failed', results: [{ label: 'teams', ok: false, message: 'Chrome not found at C:\\x' }] });
  assert.equal(spokenReply(s), "That didn't work. Teams didn't open.");
});

test('other outcomes', () => {
  assert.equal(spokenReply(sum({ outcome: 'declined' })), 'Okay, cancelled.');
  assert.equal(spokenReply(sum({ outcome: 'rejected' })), "I can't do that.");
  assert.equal(spokenReply(sum({ intent: 'unknown', outcome: 'unknown' })), "I don't know how to do that yet.");
  assert.equal(spokenReply(sum({ intent: 'unknown', outcome: 'unknown', errors: ['claude-code: boom'] })), "I couldn't reach my brain.");
  assert.equal(spokenReply(sum({ outcome: 'none' })), '');
});

test('never says the wake word, even for an app named jarvis', () => {
  const s = spokenReply(sum({ intent: 'open_app', target: 'jarvis' }));
  assert.doesNotMatch(s, /jarvis/i);
});
```

- [ ] **Step 2: Add failing tests to `test/core.test.ts`** (append at the end; reuses its `setup`/`dec` helpers)

```ts
test('handleCommand returns a summary of what happened', async () => {
  const s = setup([dec('open_app', 'teams')]);
  const summary = await handleCommand('open teams', s.ctx);
  assert.equal(summary.outcome, 'executed');
  assert.equal(summary.decision.target, 'teams');
  assert.deepEqual(summary.results, [{ label: 'teams', ok: true }]);
  assert.deepEqual(summary.errors, []);
});

test('blank input returns outcome none', async () => {
  const s = setup([]);
  assert.equal((await handleCommand('  ', s.ctx)).outcome, 'none');
});

test('unknown summary carries brain errors', async () => {
  const s = setup([]);
  s.ctx.brains.push({ name: 'broken', async decide() { throw new Error('nope'); } });
  const summary = await handleCommand('do a flip', s.ctx);
  assert.equal(summary.outcome, 'unknown');
  assert.deepEqual(summary.errors, ['broken: nope']);
});
```

- [ ] **Step 3: Add failing tests to `test/config.test.ts`** (append)

```ts
test('face and voice sections default when absent', () => {
  const c = validateConfig(rawConfig(), {});
  assert.deepEqual(c.face, { display: 0, fullscreen: true });
  assert.deepEqual(c.voice, { voice: 'af_heart', wakeWord: 'jarvis', listenTimeoutMs: 6000, maxUtteranceMs: 10000, asrModel: 'onnx-community/whisper-base.en' });
});

test('face and voice sections are validated', () => {
  const raw = rawConfig();
  raw.face = { display: 1, fullscreen: false };
  raw.voice = { voice: 'bm_george', listenTimeoutMs: 5000 };
  const c = validateConfig(raw, {});
  assert.deepEqual(c.face, { display: 1, fullscreen: false });
  assert.equal(c.voice.voice, 'bm_george');
  assert.equal(c.voice.listenTimeoutMs, 5000);
  assert.equal(c.voice.maxUtteranceMs, 10000);
  const bad = rawConfig(); bad.face = { display: -1 };
  assert.throws(() => validateConfig(bad, {}), /face\.display/);
  const bad2 = rawConfig(); bad2.voice = { listenTimeoutMs: 'soon' };
  assert.throws(() => validateConfig(bad2, {}), /voice\.listenTimeoutMs/);
});
```

- [ ] **Step 4: Run `npm test` — expect FAIL** (missing `spoken.ts`; `handleCommand` returns undefined; `c.face` undefined).

- [ ] **Step 5: Change `src/core.ts`** — add the summary type and return it from every path. Replace the `handleCommand` function (lines 27–86) with:

```ts
export interface CommandSummary {
  decision: Decision;
  outcome: Outcome | 'none';
  results: StepResult[];
  errors: string[];
}

export async function handleCommand(text: string, ctx: CoreContext): Promise<CommandSummary> {
  const input = text.trim();
  if (!input) return { decision: { intent: 'unknown', confidence: 0, source: 'none' }, outcome: 'none', results: [], errors: [] };

  const memory = loadMemory(ctx.paths.memory, ctx.catalog);
  const { decision, errors } = await decide(input, ctx.brains, ctx.catalog, memory.facts);
  const finish = (outcome: Outcome, results: StepResult[] = []): CommandSummary => {
    appendDecision(ctx.paths.log, {
      ts: new Date().toISOString(),
      text: input,
      source: decision.source,
      intent: decision.intent,
      target: decision.target,
      confidence: decision.confidence,
      outcome,
    });
    return { decision, outcome, results, errors };
  };

  if (decision.intent === 'unknown') {
    ctx.print("I don't know how to do that yet. Type 'list' to see what I can do.");
    for (const error of errors) ctx.print(`  (brain error - ${error})`);
    return finish('unknown');
  }

  ctx.print(`→ ${describe(decision)}  (${decision.source}, ${decision.confidence.toFixed(2)})`);

  const guard = checkDecision(decision, ctx.catalog);
  if (!guard.ok) {
    ctx.print(`✗ Refused: ${guard.reason}`);
    return finish('rejected');
  }
  const { entry } = guard;

  if (entry.confirm) {
    const question = entry.intent === 'remember_fact' ? `Remember "${decision.target}"?` : `${entry.description}. Proceed?`;
    if ((await ctx.ask(question)) !== true) {
      ctx.print('Cancelled.');
      return finish('declined');
    }
  }

  if (entry.intent === 'remember_fact') {
    appendFact(ctx.paths.memory, decision.target ?? '');
    ctx.print('✓ Remembered.');
    return finish('executed');
  }

  const results = await ctx.runner.run(entry);
  const succeeded = results.filter((r) => r.ok).map((r) => `✓ ${r.label}`);
  if (succeeded.length > 0) ctx.print(`  ${succeeded.join('  ')}`);
  for (const r of results.filter((r) => !r.ok)) ctx.print(`  ✗ ${r.label}: ${r.message}`);
  const summary = finish(results.every((r) => r.ok) ? 'executed' : 'failed', results);

  if (decision.source !== 'shortcut' && results.some((r) => r.ok)) {
    await maybeSuggestShortcut(input, entry, ctx);
  }
  return summary;
}
```

And change the type import line `import type { Runner } from './actions.ts';` to:

```ts
import type { Runner, StepResult } from './actions.ts';
```

- [ ] **Step 6: Create `src/spoken.ts`**

```ts
import type { StepResult } from './actions.ts';
import type { CommandSummary } from './core.ts';

function label(key: string): string {
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words ? words[0].toUpperCase() + words.slice(1) : words;
}

function failureClause(r: StepResult): string {
  return /no URL configured/i.test(r.message ?? '') ? `${label(r.label)} has no link yet.` : `${label(r.label)} didn't open.`;
}

function build(s: CommandSummary): string {
  const d = s.decision;
  switch (s.outcome) {
    case 'none': return '';
    case 'unknown': return s.errors.length > 0 ? "I couldn't reach my brain." : "I don't know how to do that yet.";
    case 'rejected': return "I can't do that.";
    case 'declined': return 'Okay, cancelled.';
    case 'failed': {
      const failed = s.results.filter((r) => !r.ok);
      if (s.results.some((r) => r.ok)) return ['Done.', ...failed.map(failureClause)].join(' ');
      return ["That didn't work.", ...failed.slice(0, 1).map(failureClause)].join(' ');
    }
    case 'executed':
      if (d.intent === 'remember_fact') return "Got it, I'll remember that.";
      if (d.intent === 'open_app') return `Opening ${label(d.target ?? '')}.`;
      if (d.intent === 'open_workspace') return `Opening your ${label(d.target ?? '').toLowerCase()} workspace.`;
      return 'Done.';
  }
  return '';
}

// Replies must never contain the wake word, or Jarvis could wake itself.
export function spokenReply(s: CommandSummary): string {
  return build(s).replace(/jarvis/gi, 'it');
}
```

- [ ] **Step 7: Extend `src/config.ts`** — add to the `JarvisConfig` interface:

```ts
  face: { display: number; fullscreen: boolean };
  voice: { voice: string; wakeWord: string; listenTimeoutMs: number; maxUtteranceMs: number; asrModel: string };
```

Add this helper above `validateConfig`:

```ts
function optionalInt(section: Obj, key: string, where: string, fallback: number, min: number): number {
  const v = section[key];
  if (v === undefined) return fallback;
  if (!Number.isInteger(v) || v < min) fail(`${where}.${key} must be a whole number of at least ${min}`);
  return v;
}
```

In `validateConfig`, just before the final `return {`, add:

```ts
  const faceRaw = raw.face === undefined ? {} : requireSection(raw, 'face');
  if (faceRaw.fullscreen !== undefined && typeof faceRaw.fullscreen !== 'boolean') fail('face.fullscreen must be true or false');
  const face = { display: optionalInt(faceRaw, 'display', 'face', 0, 0), fullscreen: faceRaw.fullscreen ?? true };
  const voiceRaw = raw.voice === undefined ? {} : requireSection(raw, 'voice');
  const voice = {
    voice: voiceRaw.voice === undefined ? 'af_heart' : requireString(voiceRaw.voice, 'voice.voice'),
    wakeWord: voiceRaw.wakeWord === undefined ? 'jarvis' : requireString(voiceRaw.wakeWord, 'voice.wakeWord'),
    listenTimeoutMs: optionalInt(voiceRaw, 'listenTimeoutMs', 'voice', 6000, 1000),
    maxUtteranceMs: optionalInt(voiceRaw, 'maxUtteranceMs', 'voice', 10000, 1000),
    asrModel: voiceRaw.asrModel === undefined ? 'onnx-community/whisper-base.en' : requireString(voiceRaw.asrModel, 'voice.asrModel'),
  };
```

and add `face,` and `voice,` to the returned object (after `memory: { suggestAfter },`).

- [ ] **Step 8: Add to `jarvis.config.json`** (after the `"memory"` line, keeping valid JSON):

```json
  "memory": { "suggestAfter": 3 },
  "face": { "display": 0, "fullscreen": true },
  "voice": { "voice": "af_heart", "wakeWord": "jarvis", "listenTimeoutMs": 6000, "maxUtteranceMs": 10000 }
```

- [ ] **Step 9: Run `npm test` — expect PASS** (92 existing + new tests; the REPL in `bin/jarvis.ts` ignores the returned summary, no change needed there).

---

### Task 2: Core — `serve` protocol and `bin/jarvis-serve.ts`

**Files:**
- Create: `src/bootstrap.ts`, `src/serve.ts`, `bin/jarvis-serve.ts`
- Modify: `bin/jarvis.ts` (use `bootstrap`)
- Test: `test/serve.test.ts`

**Interfaces:**
- Consumes: `handleCommand`, `CommandSummary`, `spokenReply`, `CoreContext`, `loadConfig`, `buildCatalog`, `buildBrains`, `loadEnv`, `loadMemory`, `createRunner`.
- Produces:
  - `bootstrap(root: string) → { paths, config, catalog, brains, status, warnings, runner }` (throws on invalid config).
  - `createServer(base: ServeContext, write: (msg: Record<string, unknown>) => void) → { handleLine(line: string): void; close(): void; idle(): Promise<void> }` where `ServeContext = Omit<CoreContext, 'ask' | 'print'>`.
  - Protocol exactly as spec §4.2; `ready` additionally carries `face` and `voice` from config.

- [ ] **Step 1: Write failing test `test/serve.test.ts`**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCatalog } from '../src/catalog.ts';
import { createServer } from '../src/serve.ts';
import type { ServeContext } from '../src/serve.ts';
import type { Brain, Decision } from '../src/types.ts';
import { sampleConfig, tempDir } from './fixtures.ts';

function setup(decisions: (Decision | null)[]) {
  const dir = tempDir();
  const config = sampleConfig();
  const queue = [...decisions];
  const brain: Brain = { name: 'scripted', async decide() { return queue.shift() ?? null; } };
  const base: ServeContext = {
    config, catalog: buildCatalog(config), brains: [brain],
    paths: { memory: join(dir, 'm.txt'), counts: join(dir, 'c.json'), log: join(dir, 'l.jsonl') },
    runner: { async run(e) { return [{ label: e.target, ok: true }]; } },
  };
  const out: any[] = [];
  const server = createServer(base, (m) => out.push(m));
  return { server, out };
}
const dec = (intent: string, target?: string): Decision => ({ intent: intent as any, target, confidence: 0.9, source: 'scripted' });

test('a command produces thinking then done with a spoken reply', async () => {
  const { server, out } = setup([dec('open_app', 'teams')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open teams' }));
  await server.idle();
  assert.deepEqual(out[0], { type: 'state', state: 'thinking' });
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.id, 'c1');
  assert.equal(done.outcome, 'executed');
  assert.equal(done.say, 'Opening Teams.');
  assert.ok(done.lines.some((l: string) => l.includes('✓ teams')));
});

test('ask waits for the matching answer', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  const ask = out.find((m) => m.type === 'ask');
  assert.match(ask.question, /Proceed\?/);
  server.handleLine(JSON.stringify({ type: 'answer', id: ask.id, value: true }));
  await server.idle();
  assert.equal(out.find((m) => m.type === 'done').outcome, 'executed');
});

test('a null answer declines', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  server.handleLine(JSON.stringify({ type: 'answer', id: out.find((m) => m.type === 'ask').id, value: null }));
  await server.idle();
  const done = out.find((m) => m.type === 'done');
  assert.equal(done.outcome, 'declined');
  assert.equal(done.say, 'Okay, cancelled.');
});

test('commands run one at a time and the queue is capped at 3', async () => {
  const { server, out } = setup([dec('open_app', 'notepad'), dec('open_app', 'teams'), dec('open_app', 'teams'), dec('open_app', 'teams')]);
  for (let i = 1; i <= 5; i++) server.handleLine(JSON.stringify({ type: 'command', id: `c${i}`, text: `command ${i}` }));   // distinct texts: no shortcut offer
  await new Promise((r) => setTimeout(r, 20));
  const busy = out.find((m) => m.type === 'done' && m.id === 'c5');
  assert.equal(busy.say, "I'm still working on the last one.");
  assert.equal(out.filter((m) => m.type === 'ask').length, 1);            // c1 is waiting; c2-c4 queued
  server.handleLine(JSON.stringify({ type: 'answer', id: out.find((m) => m.type === 'ask').id, value: false }));
  await server.idle();
  assert.deepEqual(out.filter((m) => m.type === 'done').map((m) => m.id), ['c5', 'c1', 'c2', 'c3', 'c4']);
});

test('bad lines produce warnings, never crashes', async () => {
  const { server, out } = setup([]);
  server.handleLine('not json');
  server.handleLine(JSON.stringify({ type: 'dance' }));
  server.handleLine('');
  assert.equal(out.filter((m) => m.type === 'warning').length, 2);
});

test('close answers pending questions with null so nothing hangs', async () => {
  const { server, out } = setup([dec('open_app', 'notepad')]);
  server.handleLine(JSON.stringify({ type: 'command', id: 'c1', text: 'open notepad' }));
  await new Promise((r) => setTimeout(r, 20));
  server.close();
  await server.idle();
  assert.equal(out.find((m) => m.type === 'done').outcome, 'declined');
});
```

- [ ] **Step 2: Run `npm test` — expect FAIL** (`src/serve.ts` missing).

- [ ] **Step 3: Create `src/bootstrap.ts`**

```ts
import { resolve } from 'node:path';
import { createRunner } from './actions.ts';
import { buildBrains } from './brains/index.ts';
import { buildCatalog } from './catalog.ts';
import { loadConfig } from './config.ts';
import { loadEnv } from './env.ts';
import { loadMemory } from './memory.ts';

// Shared start-up for the REPL and serve entry points. Throws if the config is invalid.
export function bootstrap(root: string) {
  const paths = {
    config: resolve(root, 'jarvis.config.json'),
    memory: resolve(root, 'jarvis-memory.txt'),
    counts: resolve(root, 'data', 'phrase-counts.json'),
    log: resolve(root, 'data', 'training-log.jsonl'),
  };
  const config = loadConfig(paths.config);
  const catalog = buildCatalog(config);
  const { brains, status, warnings } = buildBrains(loadEnv(), config, catalog, paths.memory);
  return {
    paths, config, catalog, brains, status,
    warnings: [...warnings, ...loadMemory(paths.memory, catalog).warnings],
    runner: createRunner(config),
  };
}
```

- [ ] **Step 4: Create `src/serve.ts`**

```ts
import { handleCommand } from './core.ts';
import type { CoreContext } from './core.ts';
import { spokenReply } from './spoken.ts';

export type ServeContext = Omit<CoreContext, 'ask' | 'print'>;
type Write = (msg: Record<string, unknown>) => void;

const MAX_QUEUE = 3;

export function createServer(base: ServeContext, write: Write) {
  const queue: { id: string; text: string }[] = [];
  const asks = new Map<string, (v: boolean | null) => void>();
  let running = false;
  let closed = false;
  let askSeq = 0;

  async function run(cmd: { id: string; text: string }) {
    const lines: string[] = [];
    write({ type: 'state', state: 'thinking' });
    const ctx: CoreContext = {
      ...base,
      print: (line) => { lines.push(line); },
      ask: (question) => new Promise((resolve) => {
        if (closed) return resolve(null);
        const id = `q${++askSeq}`;
        asks.set(id, resolve);
        write({ type: 'ask', id, question });
      }),
    };
    try {
      const summary = await handleCommand(cmd.text, ctx);
      write({ type: 'done', id: cmd.id, outcome: summary.outcome, say: spokenReply(summary), lines });
    } catch (e) {
      write({ type: 'done', id: cmd.id, outcome: 'failed', say: 'Something went wrong, please try again.', lines: [...lines, `✗ ${(e as Error).message}`] });
    }
  }

  function pump() {
    if (running) return;
    const next = queue.shift();
    if (!next) return;
    running = true;
    run(next).finally(() => { running = false; pump(); });
  }

  return {
    handleLine(line: string) {
      if (!line.trim()) return;
      let msg: any;
      try { msg = JSON.parse(line); } catch { write({ type: 'warning', message: 'ignored a line that is not JSON' }); return; }
      if (msg?.type === 'command' && typeof msg.id === 'string' && typeof msg.text === 'string') {
        if (running && queue.length >= MAX_QUEUE) {
          write({ type: 'done', id: msg.id, outcome: 'unknown', say: "I'm still working on the last one.", lines: [] });
          return;
        }
        queue.push({ id: msg.id, text: msg.text });
        pump();
        return;
      }
      if (msg?.type === 'answer' && typeof msg.id === 'string') {
        const resolve = asks.get(msg.id);
        if (resolve) { asks.delete(msg.id); resolve(msg.value === true ? true : msg.value === false ? false : null); }
        return;
      }
      write({ type: 'warning', message: `ignored message of type ${String(msg?.type)}` });
    },
    close() {
      closed = true;
      for (const [id, resolve] of asks) { asks.delete(id); resolve(null); }
    },
    async idle() {
      while (running || queue.length > 0) await new Promise((r) => setTimeout(r, 5));
    },
  };
}
```

- [ ] **Step 5: Create `bin/jarvis-serve.ts`**

```ts
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { bootstrap } from '../src/bootstrap.ts';
import { createServer } from '../src/serve.ts';

// JSON-lines protocol for the Electron app. stdout carries protocol lines only.
const write = (msg: Record<string, unknown>) => { process.stdout.write(JSON.stringify(msg) + '\n'); };
console.log = (...args: unknown[]) => { process.stderr.write(args.join(' ') + '\n'); };
console.warn = console.log;

let boot: ReturnType<typeof bootstrap>;
try {
  boot = bootstrap(resolve(import.meta.dirname, '..'));
} catch (e) {
  write({ type: 'fatal', message: (e as Error).message });
  process.exit(1);
}

const server = createServer(
  { config: boot.config, catalog: boot.catalog, brains: boot.brains, runner: boot.runner, paths: boot.paths },
  write,
);
write({ type: 'ready', status: boot.status, face: boot.config.face, voice: boot.config.voice });
for (const message of boot.warnings) write({ type: 'warning', message });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => server.handleLine(line));
rl.on('close', async () => { server.close(); await server.idle(); process.exit(0); });
```

- [ ] **Step 6: Refactor `bin/jarvis.ts` to use `bootstrap`** — replace lines 14–31 (from `const root = ...` through `const { brains, status, warnings } = ...`) with:

```ts
let boot: ReturnType<typeof bootstrap>;
try {
  boot = bootstrap(resolve(import.meta.dirname, '..'));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { paths, config, catalog, brains, status, warnings } = boot;
```

replace line 57 with `const ctx: CoreContext = { config, catalog, brains, runner: boot.runner, paths, ask, print };`, replace line 67 with `for (const warning of warnings) print(`! ${warning}`);`, and fix the imports at the top to:

```ts
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { bootstrap } from '../src/bootstrap.ts';
import { entryKey } from '../src/catalog.ts';
import { handleCommand } from '../src/core.ts';
import type { CoreContext } from '../src/core.ts';
```

- [ ] **Step 7: Run `npm test` — expect PASS.** Then smoke the serve entry:

Run: `echo '{"type":"command","id":"c1","text":""}' | node --disable-warning=ExperimentalWarning bin/jarvis-serve.ts`
Expected: first line `{"type":"ready","status":"brains: shortcut -> claude-code ...","face":{"display":0,"fullscreen":true},"voice":{...}}`, then `{"type":"state","state":"thinking"}` and `{"type":"done","id":"c1","outcome":"none","say":"","lines":[]}`, exit 0. (Empty text → no brain call.)

Also: `echo exit | node --disable-warning=ExperimentalWarning bin/jarvis.ts` still prints `Jarvis ready.` and exits 0.

---

### Task 3: App scaffold + CoreClient

**Files:**
- Create: `app/package.json`, `app/.gitignore`, `app/tools/vendor-three.mjs`, `app/main/coreClient.js`
- Create: `app/assets/porcupine_params.pv` (downloaded), `app/assets/bust.bin` (copied)
- Create: `app/tools/sculpt.mjs`, `app/tools/params.json`, `app/tools/face-reference.html` (copied from brainstorming), `app/tools/make-icon.mjs` → `app/assets/tray.png`
- Test: `app/test/coreClient.test.js`

**Interfaces:**
- Produces: `class CoreClient extends EventEmitter` — `new CoreClient({ spawn: () => ChildProcess, maxRestarts = 3, windowMs = 60000, now = Date.now })`; methods `start()`, `send(msg): boolean`, `stop()`; events `'message'(obj)`, `'log'(text)`, `'restarting'(code)`, `'down'(code)`.

- [ ] **Step 1: Create `app/package.json`**

```json
{
  "name": "jarvis-app",
  "version": "0.2.0",
  "private": true,
  "type": "module",
  "main": "main/main.js",
  "scripts": {
    "postinstall": "node tools/vendor-three.mjs",
    "start": "electron .",
    "smoke": "electron . --smoke",
    "test": "node --test \"test/**/*.test.js\""
  },
  "dependencies": {
    "@huggingface/transformers": "3.8.1",
    "@picovoice/porcupine-web": "4.0.1",
    "@picovoice/web-voice-processor": "4.0.10",
    "kokoro-js": "1.2.1",
    "three": "0.160.0"
  },
  "devDependencies": {
    "electron": "44.4.5"
  }
}
```

- [ ] **Step 2: Create `app/.gitignore`**

```
node_modules/
renderer/vendor/
```

- [ ] **Step 3: Create `app/tools/vendor-three.mjs`** (copies three + the post-processing add-ons into `renderer/vendor/`, rewriting the bare `'three'` import so no inline import map is needed under a strict CSP)

```js
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(APP, 'node_modules', 'three');
const OUT = join(APP, 'renderer', 'vendor');
const ENTRIES = [
  'postprocessing/EffectComposer.js', 'postprocessing/RenderPass.js', 'postprocessing/UnrealBloomPass.js',
  'postprocessing/ShaderPass.js', 'postprocessing/OutputPass.js',
];
const posix = (p) => p.split('\\').join('/');

mkdirSync(OUT, { recursive: true });
copyFileSync(join(SRC, 'build', 'three.module.js'), join(OUT, 'three.module.js'));

const done = new Set();
function copyAddon(rel) {
  if (done.has(rel)) return;
  done.add(rel);
  const src = join(SRC, 'examples', 'jsm', rel);
  const dst = join(OUT, 'addons', rel);
  const original = readFileSync(src, 'utf8');
  for (const m of original.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) copyAddon(posix(join(dirname(rel), m[1])));
  let threeRel = posix(relative(dirname(dst), join(OUT, 'three.module.js')));
  if (!threeRel.startsWith('.')) threeRel = './' + threeRel;
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, original.replace(/from\s+'three'/g, `from '${threeRel}'`));
}
ENTRIES.forEach(copyAddon);
console.log(`vendored three.module.js + ${done.size} add-on files into renderer/vendor`);
```

- [ ] **Step 3b: Create `app/tools/make-icon.mjs`** (writes a 32×32 glowing-dot tray icon to `app/assets/tray.png`)

```js
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(resolve(dirname(fileURLToPath(import.meta.url)), '..'), 'assets', 'tray.png');
const W = 32, H = 32, raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 15.5, y - 15.5), core = Math.max(0, 1 - d / 7), glow = Math.max(0, 1 - d / 15);
    const i = y * (W * 4 + 1) + 1 + x * 4;
    raw[i] = Math.min(255, 255 * core * 0.9 + 40 * glow);
    raw[i + 1] = Math.min(255, 180 * core + 140 * glow);
    raw[i + 2] = Math.min(255, 255 * glow + 60 * core);
    raw[i + 3] = Math.min(255, 255 * Math.max(core, glow * 0.85));
  }
}
const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, body) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const tb = Buffer.concat([Buffer.from(type), body]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(tb));
  return Buffer.concat([len, tb, c]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
console.log('wrote', OUT);
```

- [ ] **Step 4: Install and fetch assets**

Run (from `app/`): `npm install`
Expected: ends with `vendored three.module.js + N add-on files into renderer/vendor` (N ≥ 5).

Run (from repo root):
```bash
mkdir -p app/assets app/tools
curl -sL -o app/assets/porcupine_params.pv https://raw.githubusercontent.com/Picovoice/porcupine/v4.0/lib/common/porcupine_params.pv
cp .superpowers/brainstorm/1580-1790529817/content/bust3.bin app/assets/bust.bin
cp .superpowers/brainstorm/1580-1790529817/content/face-style-v14.html app/tools/face-reference.html
cp "$SCRATCH/bust/sculpt.mjs" app/tools/sculpt.mjs
cp "$SCRATCH/bust/params-v2.json" app/tools/params.json
node app/tools/make-icon.mjs
ls -la app/assets
```
(`$SCRATCH` = `C:/Users/USER/AppData/Local/Temp/claude/C--Zilmoney-Agentic/cf7afb18-a723-4420-b5e2-3541adca71f1/scratchpad`.)
Expected: `porcupine_params.pv` ≈ 985 KB, `bust.bin` ≈ 5.5 MB.

- [ ] **Step 5: Write failing test `app/test/coreClient.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { CoreClient } from '../main/coreClient.js';

function fakeChild() {
  const c = new EventEmitter();
  c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
  c.written = [];
  c.stdin.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) c.written.push(JSON.parse(l)); });
  c.kill = () => c.emit('exit', null);
  return c;
}
const tick = () => new Promise((r) => setTimeout(r, 10));

function setup(opts = {}) {
  const children = [];
  let t = 0;
  const client = new CoreClient({ spawn: () => { const c = fakeChild(); children.push(c); return c; }, now: () => t, ...opts });
  const events = [];
  for (const e of ['message', 'restarting', 'down']) client.on(e, (x) => events.push([e, x]));
  client.start();
  return { client, children, events, advance: (ms) => { t += ms; } };
}

test('forwards JSON lines from the core and flags non-JSON', async () => {
  const { children, events } = setup();
  children[0].stdout.write('{"type":"ready","status":"ok"}\nhello\n');
  await tick();
  assert.deepEqual(events[0], ['message', { type: 'ready', status: 'ok' }]);
  assert.equal(events[1][1].type, 'warning');
});

test('send writes one JSON line', async () => {
  const { client, children } = setup();
  assert.equal(client.send({ type: 'command', id: 'c1', text: 'hi' }), true);
  await tick();
  assert.deepEqual(children[0].written, [{ type: 'command', id: 'c1', text: 'hi' }]);
});

test('a crash fails the in-flight command and restarts the core', async () => {
  const { client, children, events } = setup();
  client.send({ type: 'command', id: 'c1', text: 'hi' });
  children[0].emit('exit', 1);
  await tick();
  const done = events.find(([e, m]) => e === 'message' && m.type === 'done');
  assert.equal(done[1].id, 'c1');
  assert.equal(done[1].outcome, 'failed');
  assert.ok(events.some(([e]) => e === 'restarting'));
  assert.equal(children.length, 2);
});

test('completed commands are not failed on a later crash', async () => {
  const { client, children, events } = setup();
  client.send({ type: 'command', id: 'c1', text: 'hi' });
  children[0].stdout.write('{"type":"done","id":"c1","outcome":"executed","say":"ok","lines":[]}\n');
  await tick();
  children[0].emit('exit', 1);
  await tick();
  assert.equal(events.filter(([e, m]) => e === 'message' && m.type === 'done').length, 1);
});

test('more than 3 crashes within a minute gives up', async () => {
  const { children, events } = setup();
  for (let i = 0; i < 4; i++) { children[children.length - 1].emit('exit', 1); await tick(); }
  assert.equal(children.length, 4);
  assert.ok(events.some(([e]) => e === 'down'));
});

test('crashes spread over time keep restarting', async () => {
  const { children, events, advance } = setup();
  for (let i = 0; i < 5; i++) { children[children.length - 1].emit('exit', 1); await tick(); advance(61000); }
  assert.equal(children.length, 6);
  assert.ok(!events.some(([e]) => e === 'down'));
});

test('stop does not restart', async () => {
  const { client, children } = setup();
  client.stop();
  await tick();
  assert.equal(children.length, 1);
  assert.equal(client.send({ type: 'command', id: 'c2', text: 'x' }), false);
});
```

- [ ] **Step 6: Run `npm test` in `app/` — expect FAIL** (`coreClient.js` missing).

- [ ] **Step 7: Create `app/main/coreClient.js`**

```js
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// Spawns and supervises the Jarvis core (JSON lines over stdio).
export class CoreClient extends EventEmitter {
  constructor({ spawn, maxRestarts = 3, windowMs = 60000, now = Date.now }) {
    super();
    Object.assign(this, { spawnChild: spawn, maxRestarts, windowMs, now });
    this.child = null;
    this.inflight = new Set();
    this.restarts = [];
    this.stopping = false;
  }

  start() { this.spawn(); }

  spawn() {
    const child = this.spawnChild();
    this.child = child;
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (!line.trim()) return;
      let msg;
      try { msg = JSON.parse(line); } catch { this.emit('message', { type: 'warning', message: 'core printed a line that is not JSON' }); return; }
      if (msg.type === 'done') this.inflight.delete(msg.id);
      this.emit('message', msg);
    });
    child.stderr?.on('data', (d) => this.emit('log', String(d)));
    child.on('error', (e) => this.emit('message', { type: 'warning', message: `core failed to start: ${e.message}` }));
    child.on('exit', (code) => { if (this.child === child) this.onExit(code); });
  }

  onExit(code) {
    this.child = null;
    for (const id of this.inflight) {
      this.emit('message', { type: 'done', id, outcome: 'failed', say: 'Something went wrong, please try again.', lines: [] });
    }
    this.inflight.clear();
    if (this.stopping) return;
    const t = this.now();
    this.restarts = this.restarts.filter((x) => t - x < this.windowMs);
    if (this.restarts.length >= this.maxRestarts) { this.emit('down', code); return; }
    this.restarts.push(t);
    this.emit('restarting', code);
    this.spawn();
  }

  send(msg) {
    if (!this.child) return false;
    if (msg.type === 'command') this.inflight.add(msg.id);
    this.child.stdin.write(JSON.stringify(msg) + '\n');
    return true;
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    this.child = null;
    child?.kill();
  }
}
```

- [ ] **Step 8: Run `npm test` in `app/` — expect PASS (7 tests).**

---

### Task 4: Controller state machine

**Files:**
- Create: `app/renderer/controller.js`
- Test: `app/test/controller.test.js`

**Interfaces:**
- Produces: `parseYesNo(text): true | false | null`; `createController(deps) → { trigger(), onTyped(text), onEvent(evt), readonly state }` where
  `deps = { face: { setState(s) }, ui: { focusInput(), setStatus(t), showError(t) }, core: { send(text): Promise<string>, answer(id, value) }, speech: { speak(text): Promise<void>, stop(), transcribe(pcm): Promise<string> }, mic: { startUtterance({ noSpeechMs, maxMs }): Promise<Float32Array|null>, cancel(), setMuted?(m) }, chime(), timers: { setTimeout }, config: { listenTimeoutMs, maxUtteranceMs } }`.
- Events handled by `onEvent` (from main): core `state` / `ask` / `done` / `warning` / `fatal`, app `hotkey`, `mute {muted}`, `core-restarting`, `core-restarted`, `core-down`, `speech-progress {percent}`, `speech-ready`, `speech-down`, `display-warning {message}`.

- [ ] **Step 1: Write failing test `app/test/controller.test.js`**

```js
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
  const c = createController({
    face: { setState: (s) => log.states.push(s) },
    ui: { focusInput: () => { log.focus++; }, setStatus() {}, showError: (e) => log.errors.push(e) },
    core: { send: async (t) => { log.sent.push(t); return 'c1'; }, answer: (id, v) => log.answers.push([id, v]) },
    speech, mic, chime: () => { log.chimes++; },
    timers: { setTimeout: (f) => f() },
    config: { listenTimeoutMs: 6000, maxUtteranceMs: 10000 },
  });
  return {
    c, log,
    hear: () => { const r = micResolve; micResolve = null; r(new Float32Array(1600)); },
    silence: () => { const r = micResolve; micResolve = null; r(null); },
    finishSpeech: () => speech.stop(),
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
});
```

- [ ] **Step 2: Run `npm test` in `app/` — expect FAIL** (`controller.js` missing).

- [ ] **Step 3: Create `app/renderer/controller.js`**

```js
// Conversation flow + face state machine. Pure logic: all I/O comes in through `deps`.
const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'affirmative', 'please', 'do']);
const NO = new Set(['no', 'nope', 'nah', 'cancel', 'stop', 'dont', 'negative']);
const FILLER = /^(\[.*\]|\(.*\)|thank you\.?|thanks\.?|you\.?)$/i;

export function parseYesNo(text) {
  const words = String(text ?? '').toLowerCase().replace(/'/g, '').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((w) => NO.has(w))) return false;
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

  const set = (s) => { state = s; face.setState(s); };
  const rest = () => set(muted ? 'muted' : 'idle');

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

  async function toText(heard) {
    if (!heard) return null;
    if (heard.text != null) return heard.text.trim();
    set('thinking');
    try { return cleanTranscript(await speech.transcribe(heard.pcm)); } catch (e) { ui.showError(`I couldn't transcribe that: ${e.message}`); return ''; }
  }

  async function submit(text) {
    set('thinking');
    ui.setStatus(`“${text}”`);
    try { await core.send(text); } catch (e) { set('error'); ui.showError(e.message); timers.setTimeout(rest, 1500); }
  }

  async function trigger() {
    if (muted || state === 'listening' || state === 'thinking' || state === 'preparing') return;
    const my = ++token;
    if (state === 'speaking') speech.stop();
    const text = await toText(await listen());
    if (my !== token) return;
    if (text === null) return rest();
    if (text === '') { await say("I didn't catch that."); if (my === token) rest(); return; }
    await submit(text);
  }

  async function onAsk(msg) {
    const my = ++token;
    await say(msg.question);
    if (my !== token) return core.answer(msg.id, null);
    const text = await toText(await listen());
    if (my !== token) return core.answer(msg.id, null);
    core.answer(msg.id, text ? parseYesNo(text) : null);
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
      case 'ask': onAsk(evt); break;
      case 'done': onDone(evt); break;
      case 'hotkey': trigger(); break;
      case 'mute':
        muted = !!evt.muted; token++;
        mic.setMuted?.(muted);
        if (muted) { mic.cancel(); speech.stop(); }
        rest();
        break;
      case 'core-restarting': set('error'); ui.showError('My core hit a problem — restarting…'); break;
      case 'core-restarted': { const my = ++token; say("I had a hiccup, but I'm back.").then(() => { if (my === token) rest(); }); break; }
      case 'core-down': case 'fatal': token++; set('error'); ui.showError(evt.message ?? 'My core stopped.'); say('My core stopped.'); break;
      case 'speech-progress': if (state === 'idle' || state === 'preparing') set('preparing'); ui.setStatus(`Preparing voice… ${evt.percent}%`); break;
      case 'speech-ready': ui.setStatus(''); if (state === 'preparing') rest(); break;
      case 'speech-down': ui.showError('Voice unavailable — you can still type.'); if (state === 'preparing') rest(); break;
      case 'warning': case 'display-warning': ui.setStatus(evt.message); break;
    }
  }

  return {
    trigger,
    onEvent,
    onTyped(text) {
      const t = String(text ?? '').trim();
      if (!t) return;
      if (typedWaiter) typedWaiter(t);
      else if (state === 'idle' || state === 'muted' || state === 'preparing' || state === 'error') submit(t);
    },
    get state() { return state; },
  };
}
```

- [ ] **Step 4: Run `npm test` in `app/` — expect PASS.**

---

### Task 5: Microphone endpointing

**Files:**
- Create: `app/renderer/endpoint.js`, `app/renderer/mic.js`
- Test: `app/test/endpoint.test.js`

**Interfaces:**
- Produces: `createEndpointer({ sampleRate = 16000, frameMs, threshold = 0.012, silenceMs = 900, maxMs = 10000, noSpeechMs = 6000, preRoll = new Float32Array(0) }) → { push(frame): 'continue' | 'end' | 'timeout', audio(): Float32Array }`;
  `createMic({ preRollMs = 500 }) → Promise<{ startUtterance({ noSpeechMs, maxMs }): Promise<Float32Array|null>, cancel(), setMuted(m): Promise<void> }>`.

- [ ] **Step 1: Write failing test `app/test/endpoint.test.js`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEndpointer } from '../renderer/endpoint.js';

const frame = (amp) => Float32Array.from({ length: 480 }, (_, i) => amp * Math.sin(i / 5));
const LOUD = 0.2, QUIET = 0.001;

test('ends after speech followed by 900 ms of silence', () => {
  const ep = createEndpointer({ frameMs: 30 });
  for (let i = 0; i < 20; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
  for (let i = 0; i < 29; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  assert.equal(ep.push(frame(QUIET)), 'end');
  assert.equal(ep.audio().length, 50 * 480);
});

test('times out when nobody speaks', () => {
  const ep = createEndpointer({ frameMs: 30, noSpeechMs: 6000 });
  for (let i = 0; i < 199; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  assert.equal(ep.push(frame(QUIET)), 'timeout');
});

test('stops at the maximum utterance length', () => {
  const ep = createEndpointer({ frameMs: 30, maxMs: 10000 });
  for (let i = 0; i < 333; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
  assert.equal(ep.push(frame(LOUD)), 'end');
});

test('pre-roll audio is kept at the start', () => {
  const ep = createEndpointer({ frameMs: 30, preRoll: new Float32Array([0.5, 0.25]) });
  ep.push(frame(LOUD));
  const a = ep.audio();
  assert.equal(a.length, 482);
  assert.equal(a[0], 0.5);
  assert.equal(a[1], 0.25);
});

test('pauses shorter than 900 ms do not end the utterance', () => {
  const ep = createEndpointer({ frameMs: 30 });
  for (let i = 0; i < 10; i++) ep.push(frame(LOUD));
  for (let i = 0; i < 20; i++) assert.equal(ep.push(frame(QUIET)), 'continue');
  for (let i = 0; i < 10; i++) assert.equal(ep.push(frame(LOUD)), 'continue');
});
```

- [ ] **Step 2: Run `npm test` in `app/` — expect FAIL.**

- [ ] **Step 3: Create `app/renderer/endpoint.js`**

```js
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
```

- [ ] **Step 4: Run `npm test` in `app/` — expect PASS.**

- [ ] **Step 5: Create `app/renderer/mic.js`** (browser-only; exercised in Task 9's live check)

```js
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
```

---

### Task 6: Speech engine (Whisper + Kokoro) and utility-process worker

**Files:**
- Create: `app/main/replyCache.js`, `app/main/speechEngine.js`, `app/main/speechWorker.js`, `app/tools/speech-smoke.mjs`
- Test: `app/test/replyCache.test.js`, `app/test/speechEngine.test.js`

**Interfaces:**
- Produces:
  - `class ReplyCache { constructor(max = 200); get(voice, text); set(voice, text, value) }` (LRU).
  - `cleanTranscript(text): string` (filler → '').
  - `createSpeechEngine({ voice = 'af_heart', asrModel = 'onnx-community/whisper-base.en', cacheDir, onProgress = () => {}, loadTts, loadAsr }) → { ready: Promise<void>, speak(text): Promise<{ pcm: Float32Array, sampleRate: number }>, transcribe(pcm: Float32Array): Promise<string> }` — `loadTts`/`loadAsr` injectable for tests.
  - Worker messages: main → worker `{ id, op: 'speak', text }` / `{ id, op: 'transcribe', pcm }`; worker → main `{ id, ok: true, result }` / `{ id, ok: false, error }` / `{ type: 'progress', percent }` / `{ type: 'ready' }` / `{ type: 'failed', message }`.

- [ ] **Step 1: Write failing tests**

`app/test/replyCache.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplyCache } from '../main/replyCache.js';

test('stores per voice and text', () => {
  const c = new ReplyCache(10);
  c.set('af_heart', 'Opening Teams.', 1);
  assert.equal(c.get('af_heart', 'Opening Teams.'), 1);
  assert.equal(c.get('bm_george', 'Opening Teams.'), undefined);
  assert.equal(c.get('af_heart', ' Opening Teams. '), 1);
});

test('evicts the least recently used entry', () => {
  const c = new ReplyCache(2);
  c.set('v', 'a', 1); c.set('v', 'b', 2);
  c.get('v', 'a');
  c.set('v', 'c', 3);
  assert.equal(c.get('v', 'b'), undefined);
  assert.equal(c.get('v', 'a'), 1);
  assert.equal(c.get('v', 'c'), 3);
});
```

`app/test/speechEngine.test.js`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, createSpeechEngine } from '../main/speechEngine.js';

function fakes() {
  const calls = { tts: 0, asr: 0 };
  const loadTts = async () => ({ generate: async (text) => { calls.tts++; return { audio: new Float32Array([text.length]), sampling_rate: 24000 }; } });
  const loadAsr = async () => async () => { calls.asr++; return { text: ' Open Teams. ' }; };
  return { calls, loadTts, loadAsr };
}

test('speak returns PCM and caches repeats', async () => {
  const f = fakes();
  const e = createSpeechEngine({ loadTts: f.loadTts, loadAsr: f.loadAsr });
  await e.ready;
  const a = await e.speak('Opening Teams.');
  const b = await e.speak('Opening Teams.');
  assert.equal(a.sampleRate, 24000);
  assert.equal(a, b);
  assert.equal(f.calls.tts, 2); // 1 warm-up + 1 real
});

test('transcribe trims text', async () => {
  const f = fakes();
  const e = createSpeechEngine({ loadTts: f.loadTts, loadAsr: f.loadAsr });
  assert.equal(await e.transcribe(new Float32Array(16000)), 'Open Teams.');
});

test('cleanTranscript drops Whisper filler for silence', () => {
  for (const t of ['[BLANK_AUDIO]', ' (silence) ', 'Thank you.', 'you']) assert.equal(cleanTranscript(t), '');
  assert.equal(cleanTranscript(' open teams '), 'open teams');
});
```

- [ ] **Step 2: Run `npm test` in `app/` — expect FAIL.**

- [ ] **Step 3: Create `app/main/replyCache.js`**

```js
// Small LRU of synthesized replies, keyed by voice + text.
export class ReplyCache {
  constructor(max = 200) { this.max = max; this.map = new Map(); }
  key(voice, text) { return `${voice}|${String(text).trim()}`; }
  get(voice, text) {
    const k = this.key(voice, text);
    const v = this.map.get(k);
    if (v !== undefined) { this.map.delete(k); this.map.set(k, v); }
    return v;
  }
  set(voice, text, value) {
    const k = this.key(voice, text);
    this.map.delete(k);
    this.map.set(k, value);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}
```

- [ ] **Step 4: Create `app/main/speechEngine.js`**

```js
import { ReplyCache } from './replyCache.js';

const FILLER = /^(\[.*\]|\(.*\)|thank you\.?|thanks\.?|you\.?)$/i;
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
    files.set(p.file, p.loaded / p.total);
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

  return {
    ready,
    async speak(text) {
      await ready;
      const hit = cache.get(voice, text);
      if (hit) return hit;
      const audio = await tts.generate(String(text), { voice });
      const value = { pcm: audio.audio, sampleRate: audio.sampling_rate };
      cache.set(voice, text, value);
      return value;
    },
    async transcribe(pcm) {
      await ready;
      const r = await asr(pcm);
      return cleanTranscript(r?.text);
    },
  };
}
```

- [ ] **Step 5: Create `app/main/speechWorker.js`** (Electron `utilityProcess` entry)

```js
import { createSpeechEngine } from './speechEngine.js';

const port = process.parentPort;
const post = (m) => port.postMessage(m);
const engine = createSpeechEngine({
  voice: process.env.JARVIS_VOICE || 'af_heart',
  asrModel: process.env.JARVIS_ASR_MODEL || 'onnx-community/whisper-base.en',
  cacheDir: process.env.JARVIS_MODELS_DIR,
  onProgress: (percent) => post({ type: 'progress', percent }),
});
engine.ready.then(() => post({ type: 'ready' }), (e) => post({ type: 'failed', message: e.message }));

port.on('message', async ({ data: m }) => {
  try {
    if (m.op === 'speak') post({ id: m.id, ok: true, result: await engine.speak(m.text) });
    else if (m.op === 'transcribe') post({ id: m.id, ok: true, result: await engine.transcribe(m.pcm) });
    else post({ id: m.id, ok: false, error: `unknown op ${m.op}` });
  } catch (e) {
    post({ id: m.id, ok: false, error: e.message });
  }
});
```

- [ ] **Step 6: Run `npm test` in `app/` — expect PASS.**

- [ ] **Step 7: Create `app/tools/speech-smoke.mjs` and run it** (real models; first run downloads ≈500 MB)

```js
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
```

Run (from `app/`): `node tools/speech-smoke.mjs`
Expected: `speak:` ≈1 s for ≈2 s audio; `cached speak:` < 5 ms; `transcribe: "Opening Teams."` (≈0.5–1.5 s).

---

### Task 7: Electron main process, preload, protocol, tray, hotkey

**Files:**
- Create: `app/main/main.js`, `app/main/preload.cjs`
- Create: `app/renderer/index.html`, `app/renderer/style.css`, `app/renderer/app.js` (minimal boot for the smoke test; completed in Task 9)

**Interfaces:**
- Consumes: `CoreClient` (Task 3), `bin/jarvis-serve.ts` protocol (Task 2), speech worker messages (Task 6).
- Produces: `window.jarvis` bridge = `{ config(): Promise<{ voice, picovoiceKey }>, command(text): Promise<string>, answer(id, value), transcribe(pcm): Promise<string>, speak(text): Promise<{ pcm, sampleRate }>, onEvent(cb), ready() }`; renderer events as listed in Task 4.

- [ ] **Step 1: Create `app/main/preload.cjs`**

```js
const { contextBridge, ipcRenderer } = require('electron');

// The only surface the face page gets. No Node, no filesystem, no shell.
contextBridge.exposeInMainWorld('jarvis', {
  config: () => ipcRenderer.invoke('jarvis:config'),
  command: (text) => ipcRenderer.invoke('jarvis:command', String(text)),
  answer: (id, value) => ipcRenderer.send('jarvis:answer', String(id), value === true ? true : value === false ? false : null),
  transcribe: (pcm) => ipcRenderer.invoke('jarvis:transcribe', pcm),
  speak: (text) => ipcRenderer.invoke('jarvis:speak', String(text)),
  onEvent: (cb) => { ipcRenderer.on('jarvis:event', (_e, evt) => cb(evt)); },
  ready: () => ipcRenderer.send('jarvis:renderer-ready'),
});
```

- [ ] **Step 2: Create `app/main/main.js`**

```js
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
  voice: { voice: 'af_heart', wakeWord: 'jarvis', listenTimeoutMs: 6000, maxUtteranceMs: 10000, asrModel: 'onnx-community/whisper-base.en' },
};

app.setName('jarvis');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
if (!app.requestSingleInstanceLock()) app.quit();

let win = null, tray = null, speech = null;
let settings = DEFAULTS, windowOpened = false, rendererReady = false, muted = false, quitting = false;
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
    if (!windowOpened) openWindow(); else send({ type: 'core-restarted' });
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
      ...process.env,
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
    pendingSpeech.set(id, { resolve, reject });
    speech.postMessage({ id, op, ...payload });
  });
}

// ---------- IPC ----------
ipcMain.handle('jarvis:config', () => ({ voice: settings.voice, picovoiceKey: process.env.PICOVOICE_ACCESS_KEY?.trim() || null }));
ipcMain.handle('jarvis:command', (_e, text) => {
  const id = `c${++seq}`;
  if (!core.send({ type: 'command', id, text: String(text).slice(0, 500) })) throw new Error('my core is not running');
  return id;
});
ipcMain.on('jarvis:answer', (_e, id, value) => {
  core.send({ type: 'answer', id: String(id), value: value === true ? true : value === false ? false : null });
});
ipcMain.handle('jarvis:transcribe', (_e, pcm) => {
  if (!(pcm instanceof Float32Array) || pcm.length === 0 || pcm.length > 16000 * 12) throw new Error('bad audio');
  return speechCall('transcribe', { pcm });
});
ipcMain.handle('jarvis:speak', (_e, text) => speechCall('speak', { text: String(text).slice(0, 400) }));
ipcMain.on('jarvis:renderer-ready', () => {
  rendererReady = true;
  for (const evt of queued.splice(0)) win.webContents.send('jarvis:event', evt);
});

// ---------- window, tray, hotkey ----------
function openWindow() {
  windowOpened = true;
  let display = screen.getAllDisplays()[settings.face.display];
  if (!display) {
    display = screen.getPrimaryDisplay();
    send({ type: 'display-warning', message: `Display ${settings.face.display} not found — using the primary display.` });
  }
  const { x, y, width, height } = display.bounds;
  win = new BrowserWindow({
    x, y, width, height,
    fullscreen: settings.face.fullscreen && !SMOKE,
    show: !SMOKE,
    title: 'Jarvis',
    backgroundColor: '#000208',
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(ICON),
    webPreferences: { preload: path.join(HERE, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadURL('app://jarvis/renderer/index.html');
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); win.hide(); } });

  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Jarvis');
  const menu = () => Menu.buildFromTemplate([
    { label: win.isVisible() ? 'Hide face' : 'Show face', click: () => { win.isVisible() ? win.hide() : win.show(); tray.setContextMenu(menu()); } },
    { label: 'Mute microphone', type: 'checkbox', checked: muted, click: (item) => { muted = item.checked; send({ type: 'mute', muted }); } },
    { type: 'separator' },
    { label: 'Quit Jarvis', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu());
  tray.on('click', () => { win.show(); win.focus(); });

  globalShortcut.register('Control+Alt+J', () => { win.show(); win.focus(); send({ type: 'hotkey' }); });

  if (SMOKE) {
    ipcMain.once('jarvis:renderer-ready', () => { console.log('SMOKE OK'); quitting = true; core.stop(); app.exit(0); });
    setTimeout(() => { console.error('SMOKE FAILED: renderer never became ready'); app.exit(1); }, 30000);
  } else {
    startSpeech();
  }
}

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(new URL(req.url).pathname)));
    if (!file.startsWith(APP_DIR + path.sep)) return new Response('forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  core.start();
  setTimeout(() => { if (!windowOpened) openWindow(); }, 15000);
});

app.on('window-all-closed', () => {});           // stay in the tray
app.on('before-quit', () => { quitting = true; core.stop(); speech?.kill(); });
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('second-instance', () => { win?.show(); win?.focus(); });
```

- [ ] **Step 3: Create `app/renderer/style.css`**

```css
html, body { margin: 0; height: 100%; background: #000208; overflow: hidden; font-family: system-ui, sans-serif; }
#c { position: fixed; inset: 0; width: 100%; height: 100%; display: block; }
#hud { position: fixed; left: 50%; bottom: 28px; transform: translateX(-50%); width: min(560px, 80vw); text-align: center; }
#status-line { color: #9cc3ff; font-size: 15px; min-height: 22px; margin-bottom: 8px; text-shadow: 0 0 8px #1e5bd6; }
#cmd { width: 100%; box-sizing: border-box; background: rgba(4, 14, 40, .55); color: #e6f1ff; border: 1px solid rgba(90, 150, 255, .3);
       border-radius: 12px; padding: 10px 14px; font-size: 15px; outline: none; }
#cmd:focus { border-color: #ffb347; box-shadow: 0 0 14px rgba(255, 179, 71, .35); }
#error { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); color: #ffb19a; font-size: 14px; }
```

- [ ] **Step 4: Create `app/renderer/index.html`**

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; connect-src 'self' blob: data: https://*.picovoice.ai; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'">
  <title>Jarvis</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <canvas id="c"></canvas>
  <div id="error"></div>
  <div id="hud">
    <div id="status-line"></div>
    <input id="cmd" placeholder="Say “Jarvis”, press Ctrl+Alt+J, or type…" autocomplete="off" spellcheck="false">
  </div>
  <script src="/node_modules/@picovoice/web-voice-processor/dist/iife/index.js"></script>
  <script src="/node_modules/@picovoice/porcupine-web/dist/iife/index.js"></script>
  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 5: Create a minimal `app/renderer/app.js`** (replaced in Task 9)

```js
document.getElementById('status-line').textContent = 'Jarvis is starting…';
window.jarvis.onEvent((evt) => { if (evt.type === 'warning') document.getElementById('status-line').textContent = evt.message; });
window.jarvis.ready();
```

- [ ] **Step 6: Smoke test**

Run (from `app/`): `npm run smoke`
Expected: prints `SMOKE OK` and exits 0 within ~10 s (the core started, reported `ready`, the window loaded over `app://`, the preload bridge worked). No speech models are loaded in smoke mode.

---

### Task 8: Face module (port of the approved v14 preview)

**Files:**
- Create: `app/renderer/face.js`, `app/tools/serve-static.mjs`
- Reference (read-only): `app/tools/face-reference.html` (copied in Task 3 — the approved v14 page)

**Interfaces:**
- Produces: `createFace(canvas, { bustUrl = '/assets/bust.bin' }) → Promise<{ setState(state), setAmplitude(value | null) }>` where state ∈ `idle | listening | thinking | speaking | error | muted | preparing`; `setAmplitude(a)` (0–1) overrides the simulated level while speaking, `null` returns to simulated.

- [ ] **Step 1: Create `app/renderer/face.js` by porting the module script of `app/tools/face-reference.html`** (the `<script type="module">` block, lines 46–end), applying exactly these changes:

1. Replace the six imports at the top with vendored paths:
```js
import * as THREE from './vendor/three.module.js';
import { EffectComposer } from './vendor/addons/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from './vendor/addons/postprocessing/ShaderPass.js';
import { OutputPass } from './vendor/addons/postprocessing/OutputPass.js';
```
2. Wrap everything after the imports in `export async function createFace(canvas, { bustUrl = '/assets/bust.bin' } = {}) { … }`; delete `const canvas = document.getElementById('c');`.
3. Delete the `addEventListener('keydown', …)` line, the whole `// ---------- state simulation ----------` UI wiring (`forced`, the `.ui button` handlers, the `burn`/`glow` slider handlers, `statusEl`), and the `statusEl.textContent = …` line in `animate`.
4. Replace the bust fetch (`const key = …` through `if (!res.ok) …`) with:
```js
const res = await fetch(bustUrl);
if (!res.ok) throw new Error(`could not load ${bustUrl}: HTTP ${res.status}`);
```
5. Add two uniforms to `U`: `uErr: { value: 0 }, uDim: { value: 0 }`, and declare them in the figure vertex shader's uniform line (`uniform float uTime, uAmp, uThink, uListen, uBurn, uPix, uErr, uDim;`). Just before `vColor = col; vAlpha = a;` in that shader insert:
```glsl
      col = mix(col, vec3(1.0, 0.28, 0.08) * (0.6 + 0.4 * sin(uTime * 28.0)), uErr * 0.55);
      a *= 1.0 - uDim * 0.65;
```
6. Above `function animate()`, add the state holder and replace `targetAmp` so it covers every state:
```js
let state = 'idle', external = null;
const STATE_AMP = { idle: 0.14, listening: 0.3, thinking: 0.2, speaking: 0.5, error: 0.2, muted: 0.06, preparing: 0.16 };
function targetAmp(t, s) {
  if (s === 'speaking') return 0.3 + 0.7 * Math.abs(Math.sin(t * 8.3) * Math.sin(t * 2.2 + 1.0) + 0.22 * Math.sin(t * 19.0));
  if (s === 'listening') return 0.2 + 0.2 * Math.abs(Math.sin(t * 4.3) * Math.sin(t * 1.4));
  if (s === 'preparing') return 0.1 + 0.08 * Math.sin(t * 1.5);
  return (STATE_AMP[s] ?? 0.14) + 0.04 * Math.sin(t * 0.8);
}
let err = 0, dim = 0;
```
7. In `animate`, replace `const s = forced ?? STATES[…];` with `const s = state;`, replace the `amp +=` line with `amp += ((external ?? targetAmp(t, s)) - amp) * 0.16;`, and after the `listen +=` line add:
```js
err += ((s === 'error' ? 1 : 0) - err) * 0.12;
dim += ((s === 'muted' ? 1 : 0) - dim) * 0.08;
U.uErr.value = err; U.uDim.value = dim;
```
In the rings loop, multiply the opacity by `(1 - dim)`: `r.material.opacity = Math.pow(Math.sin(ph * Math.PI), 1.3) * strength * (1 - dim);`.
8. Keep `animate();` and end the function with:
```js
return {
  setState(s) { state = s; },
  setAmplitude(a) { external = a == null ? null : Math.max(0, Math.min(1, a)); },
};
```

- [ ] **Step 2: Create `app/tools/serve-static.mjs`** (for headless visual checks — Chrome can't load ES modules from `file://`)

```js
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.bin': 'application/octet-stream', '.pv': 'application/octet-stream' };
const port = +(process.argv[2] ?? 8765);
createServer(async (req, res) => {
  const file = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
  try { res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file)); }
  catch { res.writeHead(404).end(); }
}).listen(port, () => console.log(`serving ${ROOT} on http://localhost:${port}`));
```

- [ ] **Step 3: Visual check in headless Chrome.** Temporarily replace `app/renderer/app.js` with:

```js
import { createFace } from './face.js';
const params = new URLSearchParams(location.search);
const face = await createFace(document.getElementById('c'));
face.setState(params.get('state') ?? 'idle');
```

Run (from `app/`, second command in another shell):
```bash
node tools/serve-static.mjs 8765
"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=1280,800 --virtual-time-budget=15000 --screenshot=face-speaking.png "http://localhost:8765/renderer/index.html?state=speaking"
```
(Also for `state=error` and `state=muted`.)
Expected: `face-speaking.png` matches the approved v14 look (round head, electric-blue contour lines, orange face burn, gold veins, sparkle burst, mountains); `error` shows a red-orange tint; `muted` is visibly dimmed with no rings. Porcupine/WVP script tags may log 404-free warnings only — no page errors. Delete the screenshots afterwards.

---

### Task 9: Wire it all together (wake word, player, UI, app.js) + acceptance

**Files:**
- Create: `app/renderer/wake.js`, `app/renderer/player.js`, `app/renderer/ui.js`
- Replace: `app/renderer/app.js`

**Interfaces:**
- Consumes: `createFace` (Task 8), `createController` (Task 4), `createMic` (Task 5), `window.jarvis` bridge (Task 7).
- Produces: the running app.

- [ ] **Step 1: Create `app/renderer/player.js`**

```js
// Plays synthesized PCM and reports its live level (0–1) so the burn follows the real voice.
export function createPlayer({ onAmplitude }) {
  const ctx = new AudioContext();
  let current = null, raf = 0;
  const stop = () => { if (current) { try { current.stop(); } catch { /* already stopped */ } } };
  return {
    stop,
    play(pcm, sampleRate) {
      stop();
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
        const tick = () => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (const v of data) sum += v * v;
          onAmplitude(Math.min(1, Math.sqrt(sum / data.length) * 4));
          raf = requestAnimationFrame(tick);
        };
        src.onended = () => { cancelAnimationFrame(raf); onAmplitude(null); if (current === src) current = null; resolve(); };
        current = src;
        ctx.resume().then(() => { src.start(); tick(); });
      });
    },
    chime() {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.25);
      osc.connect(gain); gain.connect(ctx.destination);
      ctx.resume().then(() => { osc.start(); osc.stop(ctx.currentTime + 0.26); });
    },
  };
}
```

- [ ] **Step 2: Create `app/renderer/wake.js`**

```js
// On-device "Jarvis" wake word (Porcupine). Needs a free Picovoice AccessKey.
export async function createWake({ accessKey, onWake, onError }) {
  const { PorcupineWorker, BuiltInKeyword } = window.PorcupineWeb;
  const { WebVoiceProcessor } = window.WebVoiceProcessor;
  const porcupine = await PorcupineWorker.create(
    accessKey,
    [{ builtin: BuiltInKeyword.Jarvis, sensitivity: 0.6 }],
    () => onWake(),
    { publicPath: '/assets/porcupine_params.pv', forceWrite: true },
    { processErrorCallback: (e) => onError?.(e) },
  );
  await WebVoiceProcessor.subscribe(porcupine);
  return {
    async setMuted(m) {
      if (m) await WebVoiceProcessor.unsubscribe(porcupine);
      else await WebVoiceProcessor.subscribe(porcupine);
    },
  };
}
```

- [ ] **Step 3: Create `app/renderer/ui.js`**

```js
// Text box (typing and Wispr Flow target), status line, error line.
export function createUI({ onSubmit }) {
  const input = document.getElementById('cmd');
  const status = document.getElementById('status-line');
  const error = document.getElementById('error');
  let timer = 0, errorTimer = 0;
  const submit = () => { clearTimeout(timer); const t = input.value.trim(); input.value = ''; if (t) onSubmit(t); };
  // Wispr inserts whole phrases at once: auto-send 1.2 s after a paste-like insert. Hand typing needs Enter.
  input.addEventListener('input', (e) => {
    clearTimeout(timer);
    const chunk = e.data ?? '';
    if (e.inputType === 'insertFromPaste' || e.inputType === 'insertReplacementText' || chunk.length > 1) timer = setTimeout(submit, 1200);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  return {
    focusInput() { input.focus(); },
    setStatus(text) { status.textContent = text ?? ''; },
    showError(text) {
      error.textContent = text ?? '';
      clearTimeout(errorTimer);
      errorTimer = setTimeout(() => { error.textContent = ''; }, 6000);
    },
  };
}
```

- [ ] **Step 4: Replace `app/renderer/app.js`**

```js
import { createController } from './controller.js';
import { createFace } from './face.js';
import { createMic } from './mic.js';
import { createPlayer } from './player.js';
import { createUI } from './ui.js';
import { createWake } from './wake.js';

const bridge = window.jarvis;
const face = await createFace(document.getElementById('c'));
const cfg = await bridge.config();
const player = createPlayer({ onAmplitude: (a) => face.setAmplitude(a) });

let mic = null, wake = null;
const nullMic = { startUtterance: async () => null, cancel() {}, async setMuted() {} };

let controller;
const ui = createUI({ onSubmit: (text) => controller.onTyped(text) });

controller = createController({
  face, ui,
  core: { send: (text) => bridge.command(text), answer: (id, value) => bridge.answer(id, value) },
  speech: {
    speak: async (text) => { const r = await bridge.speak(text); if (r) await player.play(r.pcm, r.sampleRate); },
    stop: () => player.stop(),
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
document.getElementById('c').addEventListener('click', () => controller.trigger());

try {
  mic = await createMic();
} catch (e) {
  ui.showError(`No microphone: ${e.message}. You can still type.`);
}
if (mic && cfg.picovoiceKey) {
  try {
    wake = await createWake({ accessKey: cfg.picovoiceKey, onWake: () => controller.trigger(), onError: (e) => ui.showError(`Wake word: ${e.message}`) });
  } catch (e) {
    ui.showError(`Wake word off: ${e.message}`);
  }
}
ui.setStatus(wake ? 'Say “Jarvis”, or press Ctrl+Alt+J' : 'Press Ctrl+Alt+J (or click me), then speak — or use Wispr / type');
bridge.ready();
```

- [ ] **Step 5: Run all tests.** Core: `npm test` (repo root) → all pass. App: `npm test` in `app/` → all pass. Smoke: `npm run smoke` in `app/` → `SMOKE OK`.

- [ ] **Step 6: Live acceptance with the user** (from `app/`: `npm start`; first launch shows "Preparing voice… N%" while models download) — spec §1:
  1. Ctrl+Alt+J → hold Wispr's key → "open teams" → Teams opens → "Opening Teams." in the Heart voice, burn moving with it.
  2. Ctrl+Alt+J → speak "agentic dev" (no Wispr) → Whisper hears it → workspace opens.
  3. With `PICOVOICE_ACCESS_KEY` set (restart the app): "Jarvis, start my day" hands-free.
  4. A shortcut offer or confirmation is asked aloud and answered "yes"/"no".
  5. Tray → Mute microphone → face dims, Ctrl+Alt+J does nothing; unmute restores.
  6. `face.display` set to the dedicated monitor index → full-screen there; an out-of-range index opens on the primary with a warning.
  7. Kill the `node … jarvis-serve.ts` process in Task Manager mid-command → face flashes error, then "I had a hiccup, but I'm back."
  8. Typing a command + Enter always works.
