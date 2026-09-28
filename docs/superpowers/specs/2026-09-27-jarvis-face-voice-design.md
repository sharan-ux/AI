# Jarvis v2 — Face + Voice — Design Spec

**Date:** 2026-09-27
**Builds on:** Jarvis Core v1 (`docs/superpowers/specs/2026-09-27-jarvis-core-design.md`), unchanged in behaviour.
**Approved visual reference:** `.superpowers/brainstorm/1580-1790529817/content/face-style-v14.html` + `bust3.bin` (user reference image: glowing contour-line humanoid bust with an orange face "burn").
**Out of scope (next spec, v3):** agent abilities — reading Teams messages, handing terminal tasks to Claude Code, read-only-by-default guardrails.

---

## 1. Goals & success criteria

Jarvis becomes a desktop app with a living face on the dedicated monitor, that you talk to and that talks back in a natural voice.

Done when, live on this laptop:
1. **Ctrl+Alt+J → Wispr Flow → "open teams"** → Teams opens → Jarvis says "Opening Teams." in the *Heart* voice while the face's burn moves with the audio.
2. With `PICOVOICE_ACCESS_KEY` set: **"Jarvis, start my day"** works hands-free (no key presses) and Jarvis speaks the result.
3. A **confirmation or shortcut offer** ("Remember 'agentic dev' as a shortcut?") is asked aloud and answered by voice ("yes"/"no").
4. **Mute** from the tray turns the microphone fully off (the face shows *muted*).
5. The face runs **full-screen on the configured monitor**.
6. Killing the core process mid-command → the app restarts it, the face shows *error* briefly, and Jarvis says it recovered.
7. Typing into the face's text box works at all times.

## 2. Non-goals (v2)

Agent abilities (v3), Azure/cloud voices (optional later), streaming partial transcripts, multi-user, auto-start with Windows, installer/packaging (run with `npm start` in `app/`), window placement of other apps.

## 3. Decisions (from brainstorming)

| Topic | Decision |
|---|---|
| Shell | **Electron** app in `app/` (user choice) |
| Core | v1 core runs as a **child process** on system Node 24 in a new `--serve` mode (JSON lines over stdio) — v1 code and 92 tests stay valid |
| Wake word | **Porcupine** built-in keyword **"Jarvis"**, on-device; needs free `PICOVOICE_ACCESS_KEY` |
| Transcription | **Local Whisper `base.en`** (transformers.js, native ONNX runtime) — hands-free after the wake word or Ctrl+Alt+J |
| Wispr Flow | Supported input: Ctrl+Alt+J (not Ctrl+Space — that is VS Code autocomplete) focuses the Jarvis text box; Wispr types into it; auto-send on pause |
| Voice out | **Kokoro-82M**, voice **`af_heart`**, **fp32** model (measured ≈1 s to synthesize a short reply on this CPU; q8 was slower here) |
| Face | Approved v14 look (three.js particles, burn, veins, aura, rings, mountains), driven by real state and real audio level |
| Privacy | No audio leaves the laptop (Porcupine, Whisper, Kokoro all local). Wispr Flow, if used, is the user's own cloud dictation tool |

## 4. Architecture

```
┌──────────────────────────── Jarvis (Electron) ────────────────────────────┐
│ MAIN process                          RENDERER (face window)              │
│  • window on configured display        • face.js  (three.js scene)        │
│  • tray: show/hide · mute · quit       • mic.js   (getUserMedia, 16 kHz,  │
│  • global shortcut Ctrl+Alt+J            end-of-speech detection)         │
│  • CoreClient ──stdio JSON──► core     • wake.js  (Porcupine "Jarvis")    │
│  • supervises core + speech worker     • player.js (plays PCM, analyser → │
│        │ IPC                             burn amplitude)                  │
│        ▼                               • ui.js    (text box, status)      │
│ SPEECH worker (utilityProcess)         • controller.js (state machine)    │
│  • Whisper base.en  (speech → text)             ▲                         │
│  • Kokoro af_heart  (text → PCM, cache)         │ preload bridge (narrow) │
└───────────────────────────────────────────────────────────────────────────┘
          core child process:  node bin/jarvis-serve.ts   (v1 logic)
```

### 4.1 Units

| Unit | Location | Responsibility |
|---|---|---|
| Serve mode | `src/serve.ts`, `bin/jarvis-serve.ts` | JSON-lines protocol over stdio around `handleCommand` |
| Spoken reply | `src/spoken.ts` | Turn a command summary into one short sentence |
| Core summary | `src/core.ts` (small change) | `handleCommand` returns a `CommandSummary` (decision, outcome, step results, brain errors) instead of `void`; REPL ignores it |
| App main | `app/main/main.js` | Window/display, tray, global shortcut, lifecycle |
| Core client | `app/main/coreClient.js` | Spawn/supervise core, parse/emit JSON lines, restart policy |
| Speech worker | `app/main/speechWorker.js` (utilityProcess) | Load Whisper + Kokoro, transcribe, synthesize, reply cache |
| Preload | `app/main/preload.js` | Expose `config`, `command`, `answer`, `transcribe`, `speak`, `onEvent`, `ready` — nothing else |
| Controller | `app/renderer/controller.js` | Face state machine + conversation flow (pure logic, testable in Node) |
| Face | `app/renderer/face.js` | v14 scene, API `setState(s)`, `setAmplitude(a)` |
| Mic / endpointing | `app/renderer/mic.js`, `app/renderer/endpoint.js` | Capture 16 kHz mono; energy-based end-of-speech (pure `endpoint.js`) |
| Wake word | `app/renderer/wake.js` | Porcupine web SDK; emits `wake` |
| Player | `app/renderer/player.js` | Play PCM via Web Audio; analyser RMS → amplitude |
| UI | `app/renderer/ui.js`, `index.html` | Text box (Wispr target), status line, error text |

### 4.2 Core `--serve` protocol (one JSON object per line)

Into the core (stdin):
- `{"type":"command","id":"c7","text":"open teams"}`
- `{"type":"answer","id":"q3","value":true | false | null}`

Out of the core (stdout):
- `{"type":"ready","status":"brains: shortcut -> claude-code | jev: off | ..."}`
- `{"type":"state","state":"thinking"}`
- `{"type":"ask","id":"q3","question":"Open Notepad. Proceed?"}`
- `{"type":"done","id":"c7","outcome":"executed","say":"Opening Teams.","lines":["→ open_app teams (claude-code, 0.98)","  ✓ teams"]}`
- `{"type":"warning","message":"..."}`

Rules: commands are processed one at a time (a new command while busy is queued, max 3; more → `done` with outcome `unknown` and say "I'm still working on the last one."). An `ask` blocks its command until the matching `answer`; `null` = no answer (same semantics as v1). Invalid JSON lines are ignored with a `warning`. Stdout carries only protocol lines; diagnostics go to stderr.

### 4.3 Spoken replies (`spokenReply(summary)`)

| Outcome | Say |
|---|---|
| executed, `open_app X` | "Opening X." (X = app key, capitalised: "Teams") |
| executed, `open_workspace X` | "Opening your X workspace." |
| executed, `run_routine X` | "Done." — plus one clause per failed step, e.g. "Jira has no link yet." / "VS Code didn't open." |
| failed (all steps failed) | "That didn't work." + first failure clause |
| executed, `remember_fact` | "Got it, I'll remember that." |
| declined | "Okay, cancelled." |
| rejected | "I can't do that." |
| unknown, no brain errors | "I don't know how to do that yet." |
| unknown, brain errors | "I couldn't reach my brain." |

Replies never contain the word "Jarvis" (self-wake guard; enforced by a test). Shortcut offers and confirmations are spoken exactly as the core's `ask.question` text.

### 4.4 Conversation flow (controller state machine)

States: `idle`, `listening`, `thinking`, `speaking`, `error`, `muted`, plus `preparing` (models loading on first run).

1. **idle** — Porcupine running (if key); face breathing.
2. Trigger: wake word **or** Ctrl+Alt+J **or** click on face → **listening**: chime; mic capture starts with 0.5 s pre-roll kept from the wake-word stream; text box focused (so Wispr can type into it).
3. End of input, whichever first:
   - **typed/Wispr text**: text box receives input, then 1.2 s with no further input (or Enter) → send text; mic capture discarded;
   - **speech**: end-of-speech (≥0.9 s below threshold after speech started; max 10 s) → PCM → Whisper → text;
   - **nothing** for 6 s → back to idle silently.
4. **thinking** — `command` sent to core.
5. Core `ask` → **speaking** the question → **listening** for the answer (no wake word needed, 6 s): transcript matched `yes/yeah/yep/sure/do it` → true, `no/nope/cancel/don't` → false, else null → `answer`.
6. Core `done` → **speaking** `say` (Kokoro; cached if seen before) → **idle**.
7. Barge-in: wake word or Ctrl+Alt+J while speaking stops playback and goes to step 2.

**Face mapping:** idle = soft breathing, faint slow rings; listening = rings contract inward, lines shimmer; thinking = scan line, burn dims to embers; speaking = burn and rings driven by real playback RMS; error = 1.5 s red-orange flicker then idle; muted = dimmed, no rings; preparing = slow pulse + "Preparing voice… 42%".

### 4.5 Configuration & environment

`jarvis.config.json` gains:
```json
"face": { "display": 1, "fullscreen": true },
"voice": { "voice": "af_heart", "wakeWord": "jarvis", "listenTimeoutMs": 6000, "maxUtteranceMs": 10000 }
```
`display` = index into Electron's display list (0 = primary); out of range → primary with a warning.
Env: `PICOVOICE_ACCESS_KEY` (optional; absent → wake word off, Ctrl+Alt+J/click only). Existing v1 env vars unchanged.
Models are downloaded on first run into `%APPDATA%\jarvis\models` (Kokoro fp32 ≈330 MB, Whisper base.en) with progress on the face; offline afterwards.

## 5. Error handling

| Failure | Behaviour |
|---|---|
| Core exits/crashes | CoreClient restarts it (≤3 restarts/min, then stays down with tray + face error "My core stopped."); in-flight command gets say "Something went wrong, please try again." |
| Speech worker crash | Restart once; if it fails again, voice out falls back to text-only status and transcription to text box only; face shows error once |
| Model download fails | Face shows "Voice unavailable — check internet" ; text box still works; retry from tray |
| No mic / permission denied | Tray warning; wake word + speech off; text box works |
| Porcupine key invalid | Warning in tray; Ctrl+Alt+J/click still work |
| Whisper returns empty text | "I didn't catch that." → idle |
| Display index missing | Use primary display, warning |

Nothing in the app ever runs an action directly — all actions still go through the core's allowlist and guard.

## 6. Security

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer; the preload exposes only the five bridge calls above.
- No remote content: three.js, Porcupine and model files are loaded from local disk; CSP `default-src 'self'` (plus `blob:`/`wasm-unsafe-eval` as required by WASM).
- Core child process is started with a fixed argv (`node bin/jarvis-serve.ts`), no shell.
- Keys only from environment variables; never logged.
- Audio is never written to disk; only transcribed text reaches the v1 decision log.

## 7. Resource budget

Measured/expected on this laptop (7.4 GB RAM, Ryzen 5 5500U): Electron ≈250 MB, Kokoro fp32 ≈400 MB, Whisper base.en ≈300 MB, face rendering on the integrated GPU. Speech worker loads models once and keeps them warm. If memory pressure becomes a problem, Whisper can be switched to `tiny.en` via config (no code change).

## 8. Testing

- **Core (node:test, existing suite):** `serve` protocol (command → state/done; ask/answer round-trip incl. null; queueing; invalid JSON warning; stdout purity), `spokenReply` table (every row above + "never contains 'Jarvis'"), `handleCommand` summary return.
- **App units (node:test, run with plain Node — no Electron):** controller state machine with fake core/mic/player/wake events (every transition in §4.4, barge-in, timeouts, yes/no matching); `endpoint.js` on synthetic PCM (speech then silence, max length, pure silence); CoreClient restart policy with a fake child; reply cache keying.
- **Visual:** headless-Chrome screenshots of the face page for each state (via a `?state=` test hook), compared by eye against v14.
- **Manual acceptance:** the 7 success criteria in §1.

## 9. Project layout (additions)

```
src/serve.ts, src/spoken.ts           core additions (+ tests in test/)
app/
  package.json                         electron, three, @picovoice/porcupine-web, @picovoice/web-voice-processor,
                                       kokoro-js, @huggingface/transformers
  main/  main.js  coreClient.js  speechWorker.js  preload.js
  renderer/  index.html  controller.js  face.js  mic.js  endpoint.js  wake.js  player.js  ui.js
  assets/  bust.bin  chime.wav
  tools/  sculpt.mjs  params.json      (bust generator from brainstorming, kept for re-tuning)
  test/  *.test.js
```
