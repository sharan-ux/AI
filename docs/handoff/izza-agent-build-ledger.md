# SDD ledger — plan: docs/superpowers/plans/2026-09-28-izza-agent.md
Spec: docs/superpowers/specs/2026-09-28-izza-agent-design.md
Baseline: core 110/110, app 76/76.
Ruling: no git commits, no worktree (user instruction) — review packages = diff vs pre-task snapshot (snap.sh) for changed files + full contents for new files (pkg.sh) — cost if wrong: none.
Ruling: batches — A: Tasks 1+2+3 (pure core, complete code), B: 4+5+6, C: 7, D: 8, E: 9 (app/ only, disjoint files → runs in parallel with A) — cost if wrong: bigger review units.
Ruling: models — sonnet implementers (complete code, but security-critical gate + many files; sonnet takes fewer turns), sonnet reviewers, opus final review.
Ruling: Task 10 (Atlassian OAuth, real-claude trial, live acceptance) is run by the controller with the user, not by subagents — real claude sessions and OAuth are outward-facing.

## Pre-flight scan
| Tasks | Produces vs consumes | Found |
|---|---|---|
| 1→7 | decide/GateContext → hub gateContext/permission | consistent |
| 2→7 | loadBoard/saveBoard/upsertTask/getTask, appendAgentLog/summarizeInput, appendProject, MemoryState.projects, config.agent | consistent (appendFact(path, fact) exists) |
| 3→7 | ensureWorktree/isGitRepo/runGit/TICKET/Git | consistent |
| 4→5,7 | ClaudeProcess/buildClaudeArgs/describeEvent | consistent |
| 5→7 | createWorkerPool start/message/stop/status/checkStalls/stopAll, WorkerEvent | consistent |
| 6→7 | bin/izza-tools.ts env IZZA_HUB_URL/TOKEN/ACTOR, POST /tool {actor,name,args} → {text}|{error} | consistent with hub HTTP |
| 7→8 | createHub deps askUser/say/progress; hub.userTurn/close | consistent with serve askUser/say/progress |
| 8→9 | agent-ask{id,question,kind}/agent-say{text}/agent-progress; answer value string|bool | consistent |
| self T1 | gate tests vs gate code (traced every case) | consistent |
| self T7 | hub tests vs hub code (asks queue, fix rounds, vscodePath) | consistent |
| self T8 | serve test "unknown falls through" uses "summarize my open pull requests" — router pre-routes it ("pull request"), so the fall-through path is not exercised | Ruling below |
| self T9 | controller tests use harness helpers; manualTimers requires firing the 1500 ms grace timer | noted in plan; implementer adapts mechanics only |
Ruling: T8 fall-through test text → "summarize my calendar" (no agent words, no ticket) so the unknown→manager fall-through is actually exercised — cost if wrong: none.
Ruling: Atlassian read-vs-write classification by tool-name regex (ATLASSIAN_WRITE) may ask for some read tools (e.g. getTransitionsForJiraIssue) — errs toward asking — cost if wrong: an extra voice confirmation.

Dispatched: batch A (Tasks 1-3, sonnet) and E (Task 9, sonnet) in parallel — disjoint files.
Batch A (Tasks 1-3): implementer DONE, 129/129; review dispatched (sonnet, package A-review-package.md).
Ruling: batch B (Tasks 4-6) dispatched while A is in review and E is implementing — files are disjoint (claudeProcess/workers/mcpServer/izza-tools/fake-claude) — cost if wrong: a transient full-suite failure seen mid-edit.
Batch B (Tasks 4-6): implementer DONE, 146/146; review dispatched.
Task 9: implementer DONE, app 81/81, smoke OK; review dispatched. Implementer flags: harness tweaks for mic.cancel in core-restarting; agent-say spoken while muted.
Task 9: Ruling: proactive agent-say is NOT spoken while muted — it stays queued and is spoken after unmute (mute already stops speech in v2, so speaking unprompted updates while muted breaks the user's mute) — cost if wrong: updates wait until unmute.
Session restart: reviews of A, B, E lost (network drop + session end); re-dispatching fresh.
Reviews A, B, E re-dispatched (sonnet, shared review-rules.md). Ruling: Task 7 (hub) dispatched while A/B are in review — only creates new files; review fixes touch module internals, not interfaces — cost if wrong: hub rework if an interface changes.
Batch B review: spec ✅; Needs fixes — Important: permission tool not fail-closed when hub unreachable (both Important findings are this one issue). Minor: stop() kill timer not cleared (folded into fix); stall report may fire while a worker waits on a long permission ask (deferred).
Batch B: ⚠️ --disallowedTools argv shape — resolved by controller: `claude --help` shows `--disallowedTools <tools...>` variadic, space-separated OK; it is the last flag and prompts go via stdin, so nothing is swallowed.
Batch B: fix round 1/5 dispatched (resume implementer).
Task 4-6: minor (deferred): worker waiting on a long permission ask is reported stalled at 10 min.
Batch A review: spec ✅; Needs fixes — 5 Important (plan-mandated): (1) Bash read cmds (cat/type/findstr…) not path-checked; (2) quote-splitting dodges SECRET/ENV_FILE; (3) lone `&` not a separator + prefix-only ALLOW; (4) summarizeInput doesn't redact inline secret values; (5) board EMPTY shares one decisions array.
Ruling: all 5 fixed (spec's hard denies + "secrets never logged" bind; the plan code was wrong): path-check read-cmd args against readRoots; normalize quotes/escapes before secret checks, shell expansion → ask, add .npmrc/.netrc/.docker/.azure/.kube to secrets; split on single &; value-level redaction; per-task decisions array — cost if wrong: more "ask" prompts for unusual commands.
Task 1-3: minor (deferred): worktree reuse check assumes repo is the origin checkout; rm -rf of a quoted in-worktree path is denied (safe-direction false positive).
Batch A: fix round 1/5 dispatched (resume implementer).
Task 9 review: Needs fixes — Critical: stale done still spoken after core-restarting under real IPC timing (test timing was altered to hide it); Important: agent-say spoken while muted (violates ruling).
Task 9: Ruling: a `restarting` flag drops every done/core-ask from the dead core between core-restarting and core-restarted/down; test timing restored to the brief's — cost if wrong: a genuine reply racing a restart is lost (the restart message is spoken instead).
Task 9: minor (deferred): older onAsk continuation clears pendingAsk while a newer ask is active (pre-existing).
Task 9: fix round 1/5 dispatched (resume implementer).
Task 9: fix round 1 implemented (app 83/83, smoke OK); scoped re-review dispatched.
Task 7: implementer DONE, 156/156 (added `closed` guard vs manager spawn after close). Flag: workers.stopAll()→stop()→pump() can launch queued workers during stopAll (B file) — to carry into B's fix loop. Review dispatched.
Ruling: Task 8 dispatched while Task 7 is in review — disjoint files, consumes only createHub/userTurn/close — cost if wrong: small wiring rework.
Task 9: fix round 1/5 (2 addressed, 0 open — stale done after restart; agent-say while muted)
Task 9: minor (deferred): sayQueue kept across a core restart (queued agent updates still true facts, so spoken after recovery); muting during a restart overwrites the error face.
Task 9: complete (review clean after fix round 1; app 83/83, smoke OK)
Batch B: fix round 1 implemented (fail-closed permission, stop timer); added stopAll→pump race to the same round.
Task 7 review (opus): spec ✅ (+justified closed guard); Needs fixes — Critical: PowerShell injection via open_terminal_tab (unvalidated worker ids, stop_worker creates records for any id). Important: gateContext fails open to process.cwd() when task/worktree missing; remember project:<KEY> widens roots without user confirm (plan-mandated); fix-round cap bypassable via lastKind (plan-mandated); single shared hub token, actor from body.
Ruling: fix all 5 + cheap minors (open_vscode path restricted to known roots & no leading '-', try/catch in onWorkerEvent, friendly error on manager death, ask timer unref/cleared on close, spoken-folder match exact-then-longest, messages use configured limits). Specifics: TICKET-validate every worker-id tool; permission() denies outright for a worker whose task/worktree is missing; onWorkerEvent ignores unknown workers; remember project: always asks the user (confirm) and requires a git repo root; fix rounds counted when status==='verifying' (set on DONE); per-actor tokens (token→actor map, body actor ignored) — cost if wrong: one extra voice confirm per new project mapping.
Task 7: minor (deferred): no manager-turn timeout; keep-alive sockets on close; no body size limit / non-constant-time token compare (localhost); resume flag true for a never-started queued session; worker waiting on input reported stalled.
Task 7: fix round 1/5 dispatched (resume implementer).
Batch B: fix round 1 done (fail-closed permission, stop timer, stopAll closed flag; full suite 171/171). Pre-fix snapshot reconstructed from briefs (reviewer had confirmed files were byte-identical to briefs). Re-review dispatched.
Batch A: fix round 1 done (171/171, 6 new RED→GREEN tests); re-review dispatched.
Task 8: implementer DONE (router+serve 13/13; full 171/171 on a quiet run); review dispatched.
Batch B: fix round 1/5 (3 addressed, 0 open — fail-closed permission; stop timer; stopAll pump race)
Tasks 4-6: complete (review clean after fix round 1)
Batch A: fix round 1/5 (5 addressed, 1 new Important — bare READ_CMD with no path args skips readRoots check (manager cwd data/agent))
Task 1-3: minor (deferred): dynamically constructed secret paths (node -e string concat) get 'ask' not deny — inherent to a lexical gate.
Batch A: fix round 2/5 dispatched.
Task 8 review: Needs fixes — 3 Important (plan-mandated): "open jira" misroutes to manager; agent turns share the single local queue (a minutes-long manager turn blocks quick commands, contradicting spec "quick commands keep their instant path"); createHub failure crashes the core.
Ruling: (1) a quick-verb command without a ticket shape stays local; drop dead jira line. (2) agent turns run in their own lane: not under the local `running` lock, tracked for idle()/close(); the hub already serializes manager turns; a quick command during a manager turn runs immediately. (3) createHub wrapped in try/catch → warning, core keeps running with agent unavailable. Minor fixed too: test for an agent turn that throws → failed done — cost if wrong: two dones may arrive out of order (the app speaks each as it arrives).
Task 8: minor (deferred): progress-throttle test doesn't check the post-window emit.
Task 8: fix round 1/5 dispatched.
Ruling: the app controller still holds 'thinking' during an agent turn (trigger/typed submit ignored while thinking), so the serve-side agent lane mainly protects queued/typed commands; making the face accept new commands mid-agent-turn is left for after the live test — cost if wrong: user waits for a long manager turn before a quick command.
Batch A: fix round 2 implemented (gate 11/11, full 185/185); re-review dispatched. Note: hub/workers tests flaked once under heavy concurrent load — recheck full suite quietly at the end.
Task 8: fix round 1 implemented (18/18; full 185/185 x2; smoke OK); re-review dispatched.
Session restart #2: resumed Task 7 fix-round-1 implementer and re-reviews for A round 2 and Task 8 round 1 (transcripts intact).
Batch A: fix round 2/5 (1 addressed, 0 open — bare read cmds check tracked cwd)
Tasks 1-3: complete (review clean after fix round 2)
Task 8: fix round 1/5 (4 addressed, 0 open — open jira local; agent lane; createHub guarded; failed-done test)
Task 8: minor (deferred): no cap on concurrent pre-routed agent turns (hub serializes them); 'thinking' state msgs carry no id.
Task 8: complete (review clean after fix round 1)
Task 7: fix round 1 implemented (hub 15/15; changed one pre-existing assertion that encoded the rapid-messages bug). Re-review dispatched.
Controller full-suite check: 183/185 then 185/185 — workers.test.ts flaky: pool uses real os.freemem (800 MB floor); laptop ~1.3 GB free idle, dips under load. Also real bug: memory-queued workers only retried on another worker's exit.
Ruling: tests inject freeMemory; checkStalls() also pumps the queue so memory-queued workers start when memory frees — cost if wrong: none.
Batch B: fix round 2/5 dispatched.
Task 7: fix round 1/5 (5 addressed + minors; follow-ups: unvalidated start_worker project key → memory-line injection widening roots (Important, pre-existing); token rotation on duplicate start disables live worker (Minor); remember confirm lacks timeout (Minor))
Ruling: fix all three in round 2 — validate project key in hub and appendProject (memory.ts edit allowed); reuse existing actor tokens; confirm via askWithTimeout — cost if wrong: none.
Task 7: minor (deferred): wt.exe treats ';' as subcommand separator — only a repo folder named with ';' could matter (config-derived, not external text).
Task 7: fix round 2/5 dispatched.
