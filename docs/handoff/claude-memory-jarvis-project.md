---
name: jarvis-project
description: "Jarvis personal assistant project in C:\\Zilmoney\\Agentic — status, decisions, and agreed next step (face + voice)"
metadata:
  node_type: memory
  type: project
  originSessionId: cf7afb18-a723-4420-b5e2-3541adca71f1
  modified: 2026-09-28T05:53:39.927Z
---

Jarvis v1 (typed REPL, Node 24 TS, zero deps) built 2026-09-27 from `jarvis-blueprint.md`; spec/plan under `docs/superpowers/`. Brain = Claude Code CLI (haiku) now; Jev/OpenRouter switch built but OFF because the user has no OpenRouter access yet. Laya (local Jev alternative) deferred; decision log `data/training-log.jsonl` is its future fine-tuning data.

User decisions: no git commits until they've run it locally; memory shortcuts must ASK before saving; build with subagents.

**Next step agreed (2026-09-27):** after the v1 live test, build Face + Voice together (option B) — local web page on the dedicated monitor, Chrome speech recognition + TTS, reacting to Jarvis states.

**v2 decisions (2026-09-27):** wake word "Jarvis" (always listening); voice must sound natural/human, not robotic. **v3 queued after v2:** agent abilities — read unread Teams messages (Graph API vs browser-driving; work tenant may need IT approval), hand terminal tasks to Claude Code, read-only-by-default + confirm guardrails against prompt injection.

**Face look (user reference image, 2026-09-27):** faceless humanoid robot head + shoulders built from glowing blue particle/contour lines (no eyes/nose/mouth); an orange-gold "burn" glow in the face area that ripples with the voice; concentric sonar-style rings pulsing out from the head; dark blue background with a glowing particle "mountain" landscape.

**Phase 3 vision (user, 2026-09-28):** Izza is a *manager agent*, not a voice relay — it plans, delegates to worker Claude Code sessions (one per task, parallel, own git worktree, task→project→session board in memory), understands/judges their output like a human lead, decides next steps, and escalates to the user. Uses Jira/Teams/Outlook via direct connectors (MCP/API) first, screen/browser-driving as fallback; can open VS Code + per-task terminal tabs for visibility. Guardrails: read freely, confirm side effects, external text = data. First milestone: "open Jira, look at XYZ" → summary → "work on that" → project + session + narrated progress. ~3 parallel tasks max on this laptop (7.4 GB RAM). Engine = **Approach A: headless Claude Code CLI** (user's own login, no API key) — manager = long-running `claude -p` stream-json session with Atlassian MCP + a custom "Izza tools" MCP server; workers = separate `claude -p` sessions per task in git worktrees; permission prompts routed to Izza via `--permission-prompt-tool` (Lead-mode voice confirms). Agent SDK rejected because it needs an API key/pay-per-use. Jira = **Jira Cloud** via the official Atlassian connector (user's own OAuth). Jira project → repo folder: **ask once, remember** in Izza's memory file (correctable). Autonomy = **Lead mode**: Izza answers workers' routine questions, commits to task branches freely, verifies worker claims itself; asks the user before push/PR/merge, Jira status changes, messages, emails, anything shared/external.

**Assistant's name is "Izza" (user, 2026-09-28)** — user-facing name everywhere (window, tray, spoken text, wake word); internal code/file names still say "jarvis". Porcupine has no built-in "Izza" → custom keyword (.ppn, Web/WASM) from Picovoice Console needed. Wake phrase chosen: **"Hey Izza"**. Rename is a bounded change to apply after the v2 final-review fixes.

**v2 stack decided (2026-09-27):** Electron app (user chose C) with core as child process (`--serve`, JSON lines over stdio). Voice out = Kokoro local TTS, voice **af_heart**, fp32 model (~1 s per short reply on this CPU; q8 is slower here), cache common replies. Voice in: Porcupine wake word ("Jarvis") + transcription when keys exist; until then Wispr Flow (user has it installed; free 2,000 words/week) into a focused Jarvis text box via Ctrl+Space, then Windows offline recognition, then typing. Azure dropped as required dependency (optional).

**Face approved (2026-09-27): preview v14** at `.superpowers/brainstorm/1580-1790529817/content/face-style-v14.html` + `bust3.bin` (baked contour points). Bust sculpt tool + params in the session scratchpad (`bust/sculpt.mjs`, `params-v2.json`) — copy into the repo when building. Style: dark navy bg, round head + short strong neck + broad soft shoulders, thick electric-blue contour lines (ripples from neck base on chest), orange face burn, gold veins neck→sternum ending in white sparkle burst, sparkle aura, lightning mountains both sides. User rejects "basic/noob" looks and inaccurate anatomy — verify renders (headless Chrome screenshot) before showing.

**Status 2026-09-28:** v2 built (live acceptance pending). Phase 3a manager agent: spec + plan approved; Tasks 1–9 built via subagents, all reviewed clean except Task 7 (hub) fix round 2 and a workers.ts memory-test fix in flight; then final whole-branch review, then Task 10 with the user (Atlassian OAuth, scripted trial with real claude only on go-ahead, live acceptance). Full handoff: `docs/HANDOFF.md` in the repo (also copies of this memory + the build ledger under `docs/handoff/`). Repo pushed to GitHub (sharan-ux/AI) at user request so work can continue on another computer. Teams/Outlook reading = Phase 3b (not started).

**Why:** user wants the "Jarvis feel"; face alone was option A and they chose B.
**How to apply:** when resuming, read docs/HANDOFF.md §6 for exactly where the build stopped; the ledger at `.superpowers/sdd/2026-09-28-izza-agent/progress.md` is authoritative on this laptop.
