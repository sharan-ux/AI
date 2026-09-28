import { randomBytes, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { launchDetached } from '../actions.ts';
import type { Launcher } from '../actions.ts';
import type { JarvisConfig } from '../config.ts';
import { appendFact, appendProject, loadMemory } from '../memory.ts';
import type { Catalog } from '../types.ts';
import { getTask, loadBoard, saveBoard, upsertTask } from './board.ts';
import { ClaudeProcess, buildClaudeArgs } from './claudeProcess.ts';
import { decide, isInside, normPath } from './gate.ts';
import type { GateContext } from './gate.ts';
import { appendAgentLog, summarizeInput } from './log.ts';
import { createWorkerPool } from './workers.ts';
import type { WorkerEvent } from './workers.ts';
import { TICKET, ensureWorktree, runGit } from './worktrees.ts';
import type { Git } from './worktrees.ts';

export interface HubDeps {
  config: JarvisConfig; root: string; dataDir: string; memoryPath: string; catalog: Catalog;
  askUser(question: string, kind: 'confirm' | 'text'): Promise<boolean | string | null>;
  say(text: string): void;
  progress(): void;
  launch?: Launcher;
  claudeCommand?: (role: 'manager' | 'worker') => { exe: string; prefixArgs: string[] };
  git?: Git;
  askTimeoutMs?: number;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9]*$/;

function formatMs(ms: number): string {
  if (ms >= 60000) { const m = Math.round(ms / 60000); return `${m} minute${m === 1 ? '' : 's'}`; }
  const s = Math.max(1, Math.round(ms / 1000));
  return `${s} second${s === 1 ? '' : 's'}`;
}

export async function createHub(deps: HubDeps) {
  const { config, root, dataDir, memoryPath, catalog } = deps;
  const launch = deps.launch ?? launchDetached;
  const git = deps.git ?? runGit;
  const askTimeoutMs = deps.askTimeoutMs ?? 10 * 60 * 1000;
  const claudeCommand = deps.claudeCommand ?? (() => ({ exe: config.claude.path, prefixArgs: [] }));
  const agentDir = join(dataDir, 'agent');
  const boardPath = join(dataDir, 'tasks.json');
  const logPath = join(dataDir, 'agent-log.jsonl');
  const workersDir = join(dataDir, 'workers');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(workersDir, { recursive: true });
  const warn = (m: string) => deps.say(m);
  const board = () => loadBoard(boardPath, warn);
  const projects = () => loadMemory(memoryPath, catalog).projects;
  const log = (actor: string, tool: string, input: unknown, decision: string, result: string) =>
    appendAgentLog(logPath, { actor, tool, summary: summarizeInput(input), decision, result });

  // A ticket key (worker id) reaches several tools straight from the model. Normalize and validate
  // it everywhere it is used, so a malformed id can never end up in a shell command or a board record.
  function normalizeWorkerId(raw: unknown): string {
    const id = String(raw ?? '').toUpperCase().trim();
    if (!TICKET.test(id)) throw new Error(`not a ticket key: ${raw}`);
    return id;
  }

  async function isRepoRoot(folder: string): Promise<boolean> {
    try {
      const top = await git(['rev-parse', '--show-toplevel'], folder);
      return normPath(top, folder) === normPath(folder, folder);
    } catch {
      return false;
    }
  }

  // ---------- per-actor tokens ----------
  // Reuse an existing actor's token rather than rotating it: mcpConfigFor runs before pool.start, so a
  // failed duplicate start_worker (worker already running) must not invalidate the live worker's token.
  const tokenToActor = new Map<string, string>();
  function tokenFor(actor: string): string {
    for (const [t, a] of tokenToActor) if (a === actor) return t;
    const t = randomBytes(24).toString('hex');
    tokenToActor.set(t, actor);
    return t;
  }

  // ---------- HTTP ----------
  let url = '';
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const send = (status: number, obj: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
      const actor = tokenToActor.get(String(req.headers['x-izza-token'] ?? ''));
      if (!actor) return send(403, { error: 'forbidden' });
      if (req.method !== 'POST' || req.url !== '/tool') return send(404, { error: 'not found' });
      try {
        const { name, args } = JSON.parse(body);
        send(200, { text: await handleTool(actor, String(name), args ?? {}) });
      } catch (e) {
        send(500, { error: (e as Error).message });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as any).port}`;

  function mcpConfigFor(actor: string, withAtlassian: boolean): string {
    const actorToken = tokenFor(actor);
    const servers: Record<string, unknown> = {
      izza: {
        type: 'stdio', command: process.execPath,
        args: ['--disable-warning=ExperimentalWarning', join(root, 'bin', 'izza-tools.ts')],
        env: { IZZA_HUB_URL: url, IZZA_HUB_TOKEN: actorToken, IZZA_ACTOR: actor },
      },
    };
    if (withAtlassian) servers.atlassian = { type: 'http', url: config.agent.atlassianUrl };
    const file = join(agentDir, `mcp-${actor.replace(/[^a-zA-Z0-9-]/g, '_')}.json`);
    writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2), 'utf8');
    return file;
  }
  const claudeEnv = { ...process.env, MCP_TOOL_TIMEOUT: String(15 * 60 * 1000) };

  // ---------- permission gate ----------
  function gateContext(actor: string): GateContext {
    const folders = [...projects().values()];
    if (actor === 'manager') return { cwd: agentDir, readRoots: [...folders, config.agent.worktreeRoot, dataDir], writeRoots: [] };
    const task = getTask(board(), actor.replace(/^worker:/, ''));
    if (!task || !task.worktree) throw new Error(`unknown worker: ${actor}`);
    return { cwd: task.worktree, readRoots: [task.worktree, task.repo], writeRoots: [task.worktree] };
  }

  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();
  async function askWithTimeout(question: string): Promise<boolean | null> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<null>((r) => {
      timer = setTimeout(() => r(null), askTimeoutMs);
      timer.unref?.();
      pendingTimers.add(timer);
    });
    const answer = await Promise.race([deps.askUser(question, 'confirm'), timeout]);
    clearTimeout(timer!);
    pendingTimers.delete(timer!);
    return answer === true ? true : answer === false ? false : null;
  }

  async function permission(actor: string, args: any): Promise<string> {
    const tool = String(args.tool_name ?? '');
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (actor !== 'manager') {
      const task = getTask(board(), actor.replace(/^worker:/, ''));
      if (!task || !task.worktree) {
        log(actor, tool, input, 'deny', 'unknown worker');
        return JSON.stringify({ behavior: 'deny', message: 'Izza denied this (unknown worker). Do not retry it.' });
      }
    }
    const d = decide({ actor, tool, input }, gateContext(actor));
    if (d.action === 'allow') { log(actor, tool, input, 'allow', 'ok'); return JSON.stringify({ behavior: 'allow', updatedInput: input }); }
    if (d.action === 'deny') { log(actor, tool, input, 'deny', d.reason); return JSON.stringify({ behavior: 'deny', message: `Izza denied this (${d.reason}). Do not retry it.` }); }
    const who = actor === 'manager' ? 'I' : `The ${actor.replace(/^worker:/, '')} worker`;
    const answer = await askWithTimeout(`${who} want${actor === 'manager' ? '' : 's'} to ${d.describe}. Allow?`);
    if (answer === true) { log(actor, tool, input, 'ask-yes', 'ok'); return JSON.stringify({ behavior: 'allow', updatedInput: input }); }
    log(actor, tool, input, answer === false ? 'ask-no' : 'timeout', 'denied');
    return JSON.stringify({ behavior: 'deny', message: answer === false ? 'The user said no.' : `No answer from the user within ${formatMs(askTimeoutMs)}; treat it as no.` });
  }

  // ---------- manager ----------
  let manager: ClaudeProcess | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  const managerFile = join(agentDir, 'manager.json');

  function ensureManager(): ClaudeProcess {
    if (closed) throw new Error('hub is closed');
    if (manager?.running) return manager;
    let sessionId = '';
    try { sessionId = JSON.parse(readFileSync(managerFile, 'utf8')).sessionId; } catch { /* first run */ }
    const resume = Boolean(sessionId);
    if (!sessionId) { sessionId = randomUUID(); writeFileSync(managerFile, JSON.stringify({ sessionId }), 'utf8'); }
    const { exe, prefixArgs } = claudeCommand('manager');
    const args = [...prefixArgs, ...buildClaudeArgs({
      sessionId, resume, model: config.agent.managerModel || undefined,
      mcpConfigPath: mcpConfigFor('manager', true), systemPromptFile: join(root, 'agent', 'manager-prompt.md'),
      addDirs: [...projects().values(), config.agent.worktreeRoot].filter((d) => existsSync(d)),
      disallowedTools: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
    })];
    manager = new ClaudeProcess({ exe, args, cwd: agentDir, env: claudeEnv });
    manager.on('event', () => deps.progress());
    manager.start();
    return manager;
  }

  function managerTurn(text: string): Promise<string> {
    const run = chain.then(async () => {
      hub.onManagerTurn?.(text);
      try {
        const r = await ensureManager().send(text);
        return r.isError ? "I couldn't finish that — something went wrong on my side." : r.text;
      } catch {
        return "I couldn't finish that — something went wrong on my side.";
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  // ---------- workers ----------
  const pool = createWorkerPool({
    exe: claudeCommand('worker').exe,
    maxConcurrent: config.agent.maxWorkers,
    onEvent: (e: WorkerEvent) => onWorkerEvent(e),
  });
  const stallTimer = setInterval(() => pool.checkStalls(), 60 * 1000);
  stallTimer.unref?.();

  function onWorkerEvent(e: WorkerEvent) {
    try {
      if (e.kind === 'progress') {
        appendFileSync(join(workersDir, `${e.worker}.log`), `${new Date().toLocaleTimeString()}  ${e.text}\n`, 'utf8');
        return;
      }
      const b = board();
      if (!getTask(b, e.worker)) {
        console.warn(`izza: ignoring ${e.kind} event for a worker not on the task board (${e.worker})`);
        return;
      }
      const status = e.kind === 'done' ? 'verifying' : e.kind === 'blocked' ? 'needs-user' : e.kind === 'failed' ? 'failed' : undefined;
      upsertTask(b, { id: e.worker, lastKind: e.kind, ...(status ? { status } : {}) });
      saveBoard(boardPath, b);
      if (!closed) managerTurn(`[worker ${e.worker} · ${e.kind}] ${e.text}`).catch(() => {});
    } catch (err) {
      console.warn(`izza: onWorkerEvent failed: ${(err as Error).message}`);
    }
  }

  function matchFolder(answer: string, candidates: string[]): string | undefined {
    const paths = candidates.map((n) => join(config.agent.projectsRoot, n));
    const a = norm(answer);
    const exact = paths.find((p) => norm(basename(p)) === a);
    if (exact) return exact;
    const contained = paths.filter((p) => { const n = norm(basename(p)); return n.length > 0 && a.includes(n); });
    if (contained.length === 0) return undefined;
    return contained.reduce((best, p) => (norm(basename(p)).length > norm(basename(best)).length ? p : best));
  }

  async function resolveProject(project: string): Promise<string> {
    if (!PROJECT_KEY.test(project)) throw new Error(`invalid project key: ${project}`);
    const known = projects().get(project);
    if (known) return known;
    const candidates = existsSync(config.agent.projectsRoot)
      ? readdirSync(config.agent.projectsRoot).filter((n) => statSync(join(config.agent.projectsRoot, n)).isDirectory())
      : [];
    const answer = await deps.askUser(`Which folder is the ${project} project in? I found: ${candidates.join(', ') || 'no folders'}.`, 'text');
    if (typeof answer !== 'string' || !answer.trim()) throw new Error(`no folder given for ${project}`);
    const folder = isAbsolute(answer.trim()) ? answer.trim() : matchFolder(answer, candidates);
    if (!folder) throw new Error(`I couldn't match "${answer}" to a folder`);
    if (!(await isRepoRoot(folder))) throw new Error(`${folder} is not the root of a git repository`);
    appendProject(memoryPath, project, folder);
    return folder;
  }

  async function startWorker(args: any): Promise<string> {
    const ticket = String(args.ticket ?? '').toUpperCase().replace(/\s+/, '-');
    if (!TICKET.test(ticket)) throw new Error(`not a ticket key: ${args.ticket}`);
    const project = String(args.project ?? ticket.split('-')[0]).toUpperCase();
    if (!PROJECT_KEY.test(project)) throw new Error(`invalid project key: ${args.project}`);
    const repo = await resolveProject(project);
    const wt = await ensureWorktree({ repo, ticket, root: config.agent.worktreeRoot, git });
    const b = board();
    const existing = getTask(b, ticket);
    const resume = Boolean(existing?.session);
    const session = existing?.session || randomUUID();
    const { exe, prefixArgs } = claudeCommand('worker');
    const base = { sessionId: session, model: config.agent.workerModel || undefined, mcpConfigPath: mcpConfigFor(`worker:${ticket}`, false), systemPromptFile: join(root, 'agent', 'worker-prompt.md'), addDirs: [], disallowedTools: [] };
    const state = pool.start({
      id: ticket, cwd: wt.path, env: claudeEnv,
      args: [...prefixArgs, ...buildClaudeArgs({ ...base, resume })],
      resumeArgs: [...prefixArgs, ...buildClaudeArgs({ ...base, resume: true })],
      brief: `Ticket ${ticket} (base branch ${wt.base}). ${String(args.brief ?? '')}`,
    });
    upsertTask(b, { id: ticket, title: String(args.title ?? existing?.title ?? ''), project, repo, worktree: wt.path, branch: wt.branch, session, status: state === 'running' ? 'running' : 'queued', rounds: existing?.rounds ?? 0 });
    saveBoard(boardPath, b);
    await launch(hub.vscodePath, [wt.path]);
    return `Worker ${ticket} ${state === 'running' ? 'started' : `queued (${config.agent.maxWorkers} already running or low memory)`} in ${wt.path} on branch ${wt.branch} from ${wt.base}.`;
  }

  async function handleTool(actor: string, name: string, args: any): Promise<string> {
    if (name === 'permission') return permission(actor, args);
    if (actor !== 'manager') throw new Error('workers can only use the permission tool');
    log(actor, name, args, 'allow', 'ok');
    const b = board();
    switch (name) {
      case 'start_worker': return startWorker(args);
      case 'message_worker': {
        const id = normalizeWorkerId(args.worker);
        const t = getTask(b, id);
        if (!t) throw new Error(`no task ${id}`);
        const fixRound = t.status === 'verifying';
        if (fixRound && t.rounds >= 3) throw new Error(`${id} already had 3 fix rounds — tell the user and ask how to proceed`);
        pool.message(id, String(args.text ?? ''));
        upsertTask(b, { id, rounds: t.rounds + (fixRound ? 1 : 0), status: 'running' });
        saveBoard(boardPath, b);
        return `Sent to ${id}.`;
      }
      case 'worker_status': {
        const live = new Map(pool.status().map((s) => [s.id, s]));
        const filterId = args.worker ? normalizeWorkerId(args.worker) : undefined;
        const list = b.tasks.filter((t) => !filterId || t.id === filterId);
        if (list.length === 0) return 'No tasks.';
        return list.map((t) => `${t.id} [${t.status}${live.get(t.id) ? `, worker ${live.get(t.id)!.state}` : ''}] ${t.title} — ${live.get(t.id)?.lastProgress ?? ''}`).join('\n');
      }
      case 'stop_worker': {
        const id = normalizeWorkerId(args.worker);
        const t = getTask(b, id);
        if (!t) throw new Error(`no task ${id}`);
        pool.stop(id);
        upsertTask(b, { id, status: 'paused' });
        saveBoard(boardPath, b);
        return `Stopped ${id}.`;
      }
      case 'open_vscode': {
        let target: string;
        if (args.worker) {
          const id = normalizeWorkerId(args.worker);
          const t = getTask(b, id);
          if (!t) throw new Error(`no task ${id}`);
          target = t.worktree;
        } else {
          const p = String(args.path ?? '');
          if (!p || p.startsWith('-')) throw new Error('invalid path');
          const resolved = resolve(p);
          const roots = [...projects().values(), config.agent.worktreeRoot];
          if (!roots.some((r) => isInside(resolved, r, agentDir))) throw new Error(`${resolved} is outside your projects`);
          target = resolved;
        }
        await launch(hub.vscodePath, [target]);
        return `Opened ${target}.`;
      }
      case 'open_terminal_tab': {
        const id = normalizeWorkerId(args.worker);
        const t = getTask(b, id);
        if (!t) throw new Error('no such worker');
        const logFile = join(workersDir, `${t.id}.log`);
        if (!existsSync(logFile)) writeFileSync(logFile, '', 'utf8');
        const escapedLog = logFile.replace(/'/g, "''");
        await launch(config.terminal.path, ['-d', t.worktree, 'powershell', '-NoExit', '-Command', `Get-Content -Wait -Tail 50 '${escapedLog}'`]);
        return `Opened a progress tab for ${t.id}.`;
      }
      case 'open_url': {
        const u = String(args.url ?? '');
        if (!/^https:\/\//i.test(u)) throw new Error('only https URLs can be opened');
        await launch(config.chrome.path, [`--profile-directory=${config.chrome.profile}`, u]);
        return `Opened ${u}.`;
      }
      case 'remember': {
        const key = String(args.key ?? ''); const value = String(args.value ?? '');
        const m = /^project:([A-Za-z][A-Za-z0-9]*)$/.exec(key);
        if (m) {
          const folder = resolve(value);
          if (!(await isRepoRoot(folder))) throw new Error(`${folder} is not the root of a git repository`);
          const ok = await askWithTimeout(`Remember that the ${m[1]} project is in ${folder}?`);
          if (ok !== true) return 'Okay, not remembered.';
          appendProject(memoryPath, m[1], folder);
          return 'Remembered.';
        }
        if (/^project/i.test(key)) throw new Error(`"${key}" is not a valid project key; use "project:<KEY>"`);
        appendFact(memoryPath, `${key}: ${value}`);
        return 'Remembered.';
      }
      case 'recall': {
        const key = String(args.key ?? '').toLowerCase();
        const mem = loadMemory(memoryPath, catalog);
        const hits = [...[...mem.projects].map(([k, v]) => `project:${k} = ${v}`), ...mem.facts].filter((l) => l.toLowerCase().includes(key));
        return hits.length ? hits.join('\n') : 'Nothing remembered for that.';
      }
      case 'ask_user': {
        const a = await deps.askUser(String(args.question ?? ''), 'text');
        return typeof a === 'string' && a.trim() ? a : '(no answer)';
      }
      case 'speak': deps.say(String(args.text ?? '')); return 'Spoken.';
      default: throw new Error(`unknown tool ${name}`);
    }
  }

  const hub = {
    url,
    vscodePath: config.vscode.path,
    onManagerTurn: undefined as undefined | ((text: string) => void),
    userTurn: (text: string) => managerTurn(text),
    handleTool,
    close() {
      closed = true;
      clearInterval(stallTimer);
      for (const t of pendingTimers) clearTimeout(t);
      pendingTimers.clear();
      pool.stopAll();
      manager?.stop();
      server.close();
    },
  };
  return hub;
}
