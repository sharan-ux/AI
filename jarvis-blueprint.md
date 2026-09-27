# Jarvis — Personal Voice Assistant Blueprint
### A voice-driven orchestrator that opens apps, runs your dev loop through Claude Code, and reacts on a dedicated monitor.

> **The one idea that shapes everything:** You are **not building an AI.** You already own the intelligence (Claude Code + OpenRouter models). You're building a **thin conductor** — ears, a mouth, a dispatcher, and a face — wrapped around AI you already have. This makes the project small enough to actually finish.

---

## 1. What Jarvis is (and is not)

| It IS | It is NOT |
|---|---|
| An **orchestrator**: hears you, decides intent, calls the right tool, speaks back | A new coding AI (Claude Code already is that) |
| A **conductor** that delegates coding jobs to Claude Code | A screen-watching robot that clicks through app windows |
| A set of **allowlisted actions** it can safely perform | A "run any command / do whatever" agent (that's the dangerous version — see §7) |

**Golden rule that recurs throughout:** *Talk to agents through their interface (API/CLI), never operate them by watching pixels and clicking.* The programmatic path is reliable; the screen-scraping path is flaky and is the thing to avoid for anything that matters.

---

## 2. The anatomy — six parts (plus eyes on demand)

1. **Ears** — speech-to-text (voice in). Whisper, or OS dictation.
2. **Router brain** — small/cheap LLM. Decides *"coding task vs system task vs needs-eyes"* and extracts arguments. Runs on **every** command.
3. **Hands** — the code that performs actions: open apps, open URLs, run allowlisted commands (OS scripting).
4. **Worker brain** — **Claude Code.** Does the actual coding work. Runs **only** when the router dispatches a coding job.
5. **Mouth** — text-to-speech (voice out).
6. **Face** — animated visual on the dedicated monitor that reacts to *listening* and *speaking*. Cosmetic, but it's what makes it *feel* like Jarvis.
7. *(On demand)* **Eyes** — screenshot + vision model, invoked only when a command needs it ("what's this error?"). **Not** always-on watching (see §6).

---

## 3. The two-brain split (the key design decision)

There are **two different LLM jobs**, and keeping them separate is what makes Jarvis fast and cheap:

- **Router brain (light, every command)** → runs on **OpenRouter**, a small cheap model. Job: classify intent + pull arguments. "open Teams" → `{action: open_app, target: "Teams"}`.
- **Worker brain (heavy, only for real work)** → **Claude Code.** Job: read/fix/test code, run the terminal.

**Why the split matters:** if every "open Teams" went through the full worker, each trivial command would be slow and wasteful. The light router dispatches instantly; Claude Code is reserved for actual coding. Right tool, right layer.

**Your tools map onto this perfectly:**
- **OpenRouter (cheap model)** → router brain + any voice/vision glue.
- **Claude Code** → worker brain.
- **Your own code** → hands (open apps/URLs) + mouth + face.

---

## 4. The full flow

```
You speak
   │
   ▼
[Ears: speech-to-text]
   │
   ▼
[Router brain — OpenRouter small model]  → intent + arguments
   │
   ├── "coding task"    → hand prompt to Claude Code (programmatically)
   │                        → read its report → [Mouth] speak result
   │
   ├── "open app / url" → run the allowlisted action → confirm
   │
   ├── "cloud session"  → list/resume session via CLI/API (see §5)
   │
   └── "needs eyes"     → screenshot → vision model → answer
   │
   ▼
[Face on dedicated monitor reacts to listening / speaking throughout]
```

---

## 5. Cloud coding sessions (your specific ask)

You want Jarvis to detect an existing running cloud session, open into that project, and "check the functionality."

**Do it through the interface, not the eyes.** Running sessions can be **listed and resumed programmatically** — query "what sessions exist for this project?", get a list, attach to the right one. Far more reliable than watching a terminal.

**"Check the functionality" is two different things — decide which you mean:**
- **(a) Status check** — is the session running / done / errored? → clean, deterministic CLI/API check. Easy.
- **(b) Verify the code works** — run the tests, test in the browser, confirm the feature behaves. → let **Claude Code (or the session's own agent) run the tests and report back.** Do **not** have Jarvis eyeball a terminal to judge this.

**Jarvis's real job here:** list sessions → resume one → tell it "check the feature" → receive its report → speak it back. Orchestration through APIs, not screen-watching.

> ⚠️ These sessions touch your project and AWS — Jarvis is acting with **real credentials** here. This piece especially stays on an allowlist with a confirm before anything destructive runs.

---

## 6. On "understand what I'm doing" (ambient mode) — build eyes-on-demand, not always-on

Two modes hide in the Jarvis dream, worlds apart in difficulty:

- **Command mode** ("open X", "fix this", "test that") — you speak, it acts. **Fully achievable today.** This is where you start and where most of the value is.
- **Ambient mode** — continuously watching your screen, *understanding context*, and *proactively* acting. Real in 2026 but **expensive, slow, and error-prone**: constant vision over your screen burns tokens every few seconds, misreads things, and "correctly decide to intervene unprompted" is exactly what current agents are weakest at.

**Verdict:** build **eyes on demand** — screenshot + vision only when a command needs sight. 90% of the value at ~5% of the cost and flakiness. Consider always-on watching *only* after you've lived with the on-demand version. Don't start there or you'll fight latency and false actions instead of shipping.

---

## 7. Security guardrails (non-negotiable — this is a work machine)

This laptop holds ZilMoney email, Forge, and AWS access. An over-powered agent on it is a **corporate-security concern**, not just personal. An LLM can misread you *or be steered by malicious content it reads while "helping"* (a crafted email, a webpage it summarizes).

**Rules:**
- **Allowlist, never open access.** Jarvis can do a *defined set* of actions you add one at a time — never a single "run whatever the AI decides" command.
- **Gate destructive/irreversible actions behind an explicit confirm.** Anything that deletes, moves money, touches production, or runs shell commands with side effects asks first.
- **Secrets in environment variables**, never hardcoded (API keys for OpenRouter, etc.).
- **Same deliberate-friction instinct you apply to payment actions at work** — apply it here to system actions.

You lose nothing useful by doing this and you close a real hole.

---

## 8. The build plan — one working rung at a time

Each step works on its own, so you're never stuck with a half-thing.

- [ ] **Step 1 — Text command → open one app.** No voice yet. Type "open Teams", it opens. *This proves the brain-to-hands link — the core of everything.*
- [ ] **Step 2 — Add more actions as an allowlist.** `open_app(name)`, `open_project(path)`, `open_url(url)`, `run_command(cmd)` (with confirm). Each a named tool added deliberately.
- [ ] **Step 3 — Add the router brain (OpenRouter).** Now a free-form sentence gets classified into an action + arguments, instead of exact typed commands.
- [ ] **Step 4 — Add voice in and out.** Speech-to-text on the front, text-to-speech on the reply. *The hands-free Jarvis feel arrives here.*
- [ ] **Step 5 — Dispatch coding tasks to Claude Code (programmatically).** Now "fix this bug and test it" works through the real agent. *Your VS Code → fix → test example is done here.*
- [ ] **Step 6 — Add the face.** Animated presence on the dedicated monitor, reacting to listening/speaking events. (Can be stubbed early for motivation, wired to real events now.)
- [ ] **Step 7 — Add eyes on demand.** Screenshot + vision when a command needs sight.
- [ ] **Step 8 — Cloud-session orchestration (§5).** List/resume/report on running sessions.
- [ ] **Later (optional) — Ambient watching**, only if you still want it after living with on-demand.

---

## 9. The face

What you saw (a glowing reactive "presence") is a **front-end**: a full-screen web page or app with an animated orb/face that pulses on audio input and output. It's cosmetic — it sits *on top* of the real engine. Build a placeholder early for motivation; wire it to real events (listening → animate, speaking → animate) once the engine works. Don't let it distract from Step 1.

---

## 10. Where Jev fits: it doesn't

Jev is a narrow typed-decision model (Choice / Score / Noul). It can't open apps or control a computer, and even the "route this command" job is better handled by the router brain. **Leave Jev out of Jarvis.**

---

## 11. Open decision before Step 1

**What OS is the three-monitor machine — Windows or Mac?** It changes how the "hands" are written:

- **Windows** (likely, given your Forge/Windows setup): PowerShell / `pyautogui`; open apps via `start` or `Start-Process`.
- **Mac:** AppleScript / `osascript`; open apps via `open -a`.
- **Linux:** shell + `xdotool`; open apps via their binary or `.desktop` entries.

Once you confirm the OS, Step 1 is a ~20-line script: type a command → an app opens. From there we climb the rungs.

---

### Why this is a great project for your goals
It's the agent loop, OS integration, API orchestration, voice, and vision in one build — exactly the architecture-level, stack-agnostic muscle you set out to develop. And you already own the two hardest components (Claude Code + OpenRouter), so most of the work is the *wiring*, which is where the real learning lives.
