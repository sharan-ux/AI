# Jarvis Core (v1) — Design Spec

**Date:** 2026-09-27
**Source:** `jarvis-blueprint.md` (Steps 1–3), plus decisions made in brainstorming.
**Scope of this spec:** a typed-command Jarvis that understands a sentence, picks an allowlisted action, and runs it — with pluggable brains (Claude Code now, Jev/OpenRouter later), a text-file memory, and decision logging. Voice, face, eyes, coding-task dispatch and cloud-session orchestration are **out of scope** and get their own specs later.

---

## 1. Goals & success criteria

**Primary use case:** "start my day" and named workspaces like "agentic dev".

v1 is done when, on this Windows 11 laptop:

1. Typing `start my day` opens Teams (Chrome), Jira (Chrome), Outlook and VS Code on the configured project.
2. Typing `agentic dev` opens VS Code on `C:\Zilmoney\Agentic` **and** a Windows Terminal tab in that folder running Claude Code resuming the configured session.
3. Free-form phrasing ("hey, open up teams for me", "let's get agentic going") is understood via the brain, not only exact phrases.
4. After a phrase is used 3 times, Jarvis **asks** whether to save it as a shortcut; on "yes" it is written to `jarvis-memory.txt` and subsequent uses skip the brain entirely.
5. Setting `JEV_ENABLED=true` with an `OPENROUTER_API_KEY` routes decisions through Jev first, with no code changes; with it off (default), Claude Code is the only brain.
6. Every decision is appended to `data/training-log.jsonl`.
7. Jarvis can never perform an action not declared in `jarvis.config.json`.

## 2. Non-goals (v1)

Voice in/out, animated face, screenshots/vision, dispatching coding tasks to Claude Code, listing/resuming cloud sessions by query, window placement per monitor, running arbitrary shell commands, Laya local hosting, fine-tuning.

## 3. Constraints (verified on this machine)

- Windows 11, PowerShell 5.1, **Node v24** (runs `.ts` natively via type stripping — no build step).
- **No Python** installed → no Python dependencies.
- 7.4 GB RAM, no CUDA GPU → no local models in v1.
- Claude Code CLI supports `-p`, `--model`, `--system-prompt`, `--tools`, `--json-schema`, `--output-format json`, `--no-session-persistence`, `--continue`, `--resume <id>`.
- Windows Terminal (`wt.exe`) and Chrome are installed. VS Code is being installed. Executables are launched by full path (`chrome.path`, `vscode.path`, `claude.path`; `%VAR%` expanded) — never through a shell. Claude Code is a native `claude.exe` under the npm folder.
- Work laptop with ZilMoney/Forge/AWS access → allowlist + confirm are mandatory.

## 4. Approach

**Chosen: Node.js + TypeScript, zero runtime dependencies, interactive terminal REPL.**

Alternatives considered:
- *PowerShell script* — quickest for Step 1 but awkward for JSON, HTTP, tests, and the later voice/face web front-end.
- *Python* — best voice/ML ecosystem, but not installed and adds weight now.

Node wins: already installed, native `fetch` for Jev/OpenRouter, built-in `node:test`, and the future face/voice can be a local web page talking to the same process.

## 5. Architecture

```
            ┌──────────────────────── jarvis (REPL) ────────────────────────┐
 you type → │ input ─► Brain chain ─► Decision ─► Guard ─► Action runner ─► reply │
            │            │                          (allowlist,   (open app/url/  │
            │            │                           confirm)      workspace/     │
            │            ▼                                          routine)      │
            │   1. Shortcuts (memory)                                             │
            │   2. Jev  (if JEV_ENABLED)                                          │
            │   3. Claude Code  (always)                                          │
            │   [OpenRouter LLM slot — present, disabled]                         │
            │                                                                     │
            │ side effects: training-log.jsonl, phrase counts, memory prompts     │
            └─────────────────────────────────────────────────────────────────────┘
```

### 5.1 Units

| Unit | File | Responsibility | Depends on |
|---|---|---|---|
| Config | `src/config.ts` | Load + validate `jarvis.config.json` and env vars; build the action **catalog** | fs |
| Catalog | `src/catalog.ts` | List of callable intents (id, description, argument options) derived from config — the only things a brain may choose | Config |
| Decision type | `src/types.ts` | `Decision = { intent, target?, confidence, source }`, `Brain` interface | — |
| Shortcut brain | `src/brains/shortcut.ts` | Exact (normalized) phrase → decision from memory | Memory |
| Jev brain | `src/brains/jev.ts` | POST to `JEV_URL` (OpenRouter Decisions API) with typed choice questions; returns decision + probability | fetch |
| Claude Code brain | `src/brains/claudeCode.ts` | Spawn `claude -p` with tools disabled and a JSON schema; parse decision | child_process |
| OpenRouter brain | `src/brains/openrouter.ts` | Chat-completions slot; disabled unless `OPENROUTER_LLM_ENABLED=true` | fetch |
| Brain chain | `src/brainChain.ts` | Try brains in order; accept first decision ≥ its threshold; fall through otherwise | brains |
| Guard | `src/guard.ts` | Verify decision is in catalog; resolve to concrete action(s); require confirm when flagged | Catalog |
| Actions | `src/actions/*.ts` | `openApp`, `openUrl`, `openWorkspace`, `runRoutine` — each builds a **fixed argv** and spawns it (no shell string interpolation) | child_process |
| Memory | `src/memory.ts` | Read/write `jarvis-memory.txt` (shortcuts + facts); phrase counting in `data/phrase-counts.json` | fs |
| Decision log | `src/decisionLog.ts` | Append JSONL records | fs |
| REPL | `src/repl.ts`, `bin/jarvis.ts` | Prompt loop, built-in commands, confirmations, output | all |

### 5.2 Config (`jarvis.config.json`) — the allowlist

```json
{
  "chrome": { "path": "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "profile": "Default" },
  "vscode": { "path": "%LOCALAPPDATA%\\Programs\\Microsoft VS Code\\Code.exe" },
  "claude": { "path": "%APPDATA%\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" },
  "apps": {
    "outlook": { "description": "Outlook email", "url": "https://outlook.office.com/mail/" },
    "teams":   { "description": "Microsoft Teams", "url": "https://teams.microsoft.com/" },
    "jira":    { "description": "Jira board", "url": "" }
  },
  "workspaces": {
    "agentic": {
      "description": "Agentic dev — Jarvis project",
      "folder": "C:\\Zilmoney\\Agentic",
      "claude": { "mode": "resume", "sessionId": "cf7afb18-a723-4420-b5e2-3541adca71f1" }
    }
  },
  "routines": {
    "start_day": { "description": "Start my workday", "steps": ["app:teams", "app:jira", "app:outlook", "workspace:agentic"] }
  },
  "memory": { "suggestAfter": 3 }
}
```

- An app is either `{ url }` (opened in Chrome) or `{ exe, args? }` (launched directly). Outlook defaults to web in Chrome; switching to desktop is `{ "exe": "C:\\Program Files\\Microsoft Office\\root\\Office16\\OUTLOOK.EXE" }`.
- An app with an empty `url` and no `exe` is **unconfigured**: running it prints "jira has no URL configured — set apps.jira.url in jarvis.config.json" and a routine continues with the next step.
- Workspace `claude.mode`: `"continue"` → `claude --continue`; `"resume"` → `claude --resume <sessionId>`; `"none"` → no terminal. If a resume fails in the terminal, the user sees Claude's own error there; Jarvis does not retry.
- Any entry may set `"confirm": true` to require a yes before running.

### 5.3 Catalog & intents

The catalog exposes these intents; `target` must be one of the listed keys:

| Intent | Target | Effect |
|---|---|---|
| `open_app` | key of `apps` | open that app |
| `open_workspace` | key of `workspaces` | VS Code on folder + terminal with Claude |
| `run_routine` | key of `routines` | run steps in order |
| `remember_fact` | free text | append a `fact:` line to memory (always asks to confirm) |
| `unknown` | — | "I don't know how to do that yet" — nothing runs |

### 5.4 Brains

All brains implement `decide(text, catalog, memoryFacts): Promise<Decision | null>`.

- **Shortcut** — normalizes text (lowercase, trim, collapse spaces, strip punctuation and a leading "jarvis"), looks up `shortcut:` lines. Confidence 1.0.
- **Jev** — enabled only if `JEV_ENABLED=true` **and** `OPENROUTER_API_KEY` is set (else logs a one-time warning and is skipped). Sends one `choice` question over the intent+target combinations (flattened, e.g. `open_app:teams`) to `JEV_URL` (default `https://openrouter.ai/api/alpha/decisions`, body `{ model, state, questions: { action: { type: "choice", instructions, criteria } } }`, response `answers.action.{choice, probabilities}`; model `JEV_MODEL` default `typesafe/jev-1.13`). Accept if probability ≥ `JEV_THRESHOLD` (default 0.75). Never used for `remember_fact` (needs free text) — falls through. Timeout 5 s → fall through. The request/response shape is isolated in this one file so it can be adjusted against the live API docs without touching anything else.
- **Claude Code** — runs `<claude.path> -p --model haiku --tools "" --no-session-persistence --output-format json --json-schema <schema> --system-prompt <prompt>` with the user text on stdin. The system prompt lists the catalog and memory facts and says to output only a decision. Model overridable via `CLAUDE_BRAIN_MODEL`. Timeout 60 s. Invalid/unknown output → `unknown`.
- **OpenRouter LLM** — present, off unless `OPENROUTER_LLM_ENABLED=true`; placed before Claude Code when on.

Chain order: Shortcut → Jev → OpenRouter LLM → Claude Code. First non-null decision wins.

### 5.5 Guard (safety)

- Rejects any decision whose intent/target isn't in the catalog (defence against a confused or manipulated brain).
- Asks `Proceed? (y/n)` for entries with `confirm: true` and for `remember_fact`.
- Actions spawn executables with argument arrays — never a concatenated shell string built from user/brain text.
- Brains never receive tools; Claude Code runs with `--tools ""`.

### 5.6 Actions (Windows)

- **openUrl(url)** → `chrome.exe --profile-directory=<profile> <url>`.
- **openApp** → `openUrl` or spawn `exe` detached.
- **openWorkspace** → `<vscode.path> <folder>` (detached) and, if claude mode ≠ none, `wt.exe -d <folder> <claude.path> --resume <id>` / `claude --continue`.
- **runRoutine** → run each step sequentially; collect per-step ok/failed; report a one-line summary.

A missing executable yields a clear message (e.g. "VS Code command 'code' not found — install VS Code or set vscode.command") and does not crash Jarvis.

### 5.7 Memory (`jarvis-memory.txt`)

Plain text, one entry per line, `#` comments allowed, human-editable:

```
# Jarvis memory — edit freely
shortcut: agentic dev => open_workspace agentic
shortcut: start my day => run_routine start_day
fact: my Jira board is the PAY project
```

- **Phrase counting:** after every *successfully executed* brain decision (not shortcut hits), increment the count for `(normalizedPhrase → intent target)` in `data/phrase-counts.json`.
- When a count reaches `memory.suggestAfter` (3), Jarvis asks: *"You've said 'agentic dev' 3 times. Remember it as a shortcut? (y/n)"* — **yes** appends the shortcut line; **no** records it as declined so it isn't asked again.
- Shortcuts are validated against the catalog on load; an invalid line is ignored with a warning (so memory can never grant a new ability).
- Facts are passed to brains as context.

### 5.8 Decision log (`data/training-log.jsonl`)

One JSON object per decision:
`{ ts, text, source, intent, target, confidence, outcome }` where `outcome` ∈ `executed | declined | failed | rejected | unknown`. This is the future Jev/Laya fine-tuning dataset. `data/` is git-ignored.

### 5.9 REPL

```
Jarvis ready (brain: claude-code; jev: off). Type 'help'.
jarvis> start my day
→ run_routine start_day  (claude-code, 0.93)
  ✓ teams  ✓ outlook  ✓ agentic  ✗ jira: no URL configured
jarvis>
```

Built-ins handled without any brain: `help`, `list` (shows catalog), `memory` (prints memory file), `status` (brains on/off), `exit`.

### 5.10 Environment variables

| Var | Default | Purpose |
|---|---|---|
| `JEV_ENABLED` | `false` | turn Jev brain on |
| `OPENROUTER_API_KEY` | — | key for Jev and OpenRouter LLM |
| `JEV_URL` | `https://openrouter.ai/api/alpha/decisions` | point at OpenRouter or a local Laya |
| `JEV_MODEL` | `typesafe/jev-1.13` | Jev model id |
| `JEV_THRESHOLD` | `0.75` | min probability to accept |
| `OPENROUTER_LLM_ENABLED` | `false` | turn LLM slot on |
| `OPENROUTER_MODEL` | — | model id for LLM slot |
| `CLAUDE_BRAIN_MODEL` | `haiku` | model for Claude Code brain |

Secrets only via env vars; never written to config, memory, or logs.

## 6. Error handling

- Brain errors/timeouts → fall through to next brain; if all fail → `unknown` with the reason printed.
- Action failures are per-step and never crash the REPL.
- Corrupt `phrase-counts.json` → reset to `{}` with a warning; corrupt memory lines → skipped with a warning.
- Invalid config → Jarvis refuses to start and prints the exact problem.

## 7. Testing

`node --test` with no external deps:
- Unit: config validation, catalog building, text normalization, shortcut matching, memory parse/write, phrase counting + suggestion threshold, guard (rejects off-catalog decisions, confirm prompts), brain chain fall-through, Claude Code output parsing, Jev request building/response parsing (fetch mocked), action argv construction (spawn mocked — nothing actually opens in tests).
- Manual acceptance: the 7 success criteria in §1, run on this laptop.

## 8. Project layout

```
C:\Zilmoney\Agentic\
  bin/jarvis.ts            entry point
  src/…                    units from §5.1
  test/…                   node:test files
  jarvis.config.json       allowlist (committed)
  jarvis-memory.txt        memory (personal; git-ignored)
  data/                    training-log.jsonl, phrase-counts.json (git-ignored)
  jarvis.cmd               double-click / PATH launcher
  package.json             scripts: start, test (no dependencies)
  docs/superpowers/specs/  this spec
```

## 9. Future specs (not built here)

2. Voice in/out · 3. Coding-task dispatch to Claude Code · 4. Face on the dedicated monitor · 5. Eyes on demand · 6. Cloud-session orchestration · 7. Laya local + periodic fine-tuning from `training-log.jsonl`.
