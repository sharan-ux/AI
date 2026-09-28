import { freemem } from 'node:os';
import { ClaudeProcess, describeEvent } from './claudeProcess.ts';

export type WorkerKind = 'done' | 'question' | 'blocked' | 'reply' | 'error' | 'crashed' | 'failed' | 'stalled' | 'progress';
export interface WorkerEvent { worker: string; kind: WorkerKind; text: string }
export interface WorkerSpec { id: string; cwd: string; args: string[]; resumeArgs: string[]; brief: string; env?: NodeJS.ProcessEnv }

const RESTART_NOTE = 'Izza: you were restarted after a crash. Continue where you left off and end with a STATUS line.';

export function parseStatus(text: string): { kind: 'done' | 'question' | 'blocked' | 'reply'; line: string } {
  const m = /STATUS:\s*(DONE|QUESTION|BLOCKED)\b\s*[—–-]?\s*(.*)$/im.exec(text);
  if (!m) return { kind: 'reply', line: text.trim().split(/\r?\n/).pop() ?? '' };
  return { kind: m[1].toLowerCase() as 'done' | 'question' | 'blocked', line: m[2].trim() };
}

export function createWorkerPool(opts: {
  exe: string; maxConcurrent?: number; stallMs?: number; now?: () => number;
  freeMemory?: () => number; minFreeBytes?: number; spawnFn?: any; onEvent: (e: WorkerEvent) => void;
}) {
  const { exe, onEvent } = opts;
  const maxConcurrent = opts.maxConcurrent ?? 3;
  const stallMs = opts.stallMs ?? 600000;
  const now = opts.now ?? Date.now;
  const freeMemory = opts.freeMemory ?? freemem;
  const minFree = opts.minFreeBytes ?? 800 * 1024 * 1024;
  const workers = new Map<string, any>();
  const queue: any[] = [];
  let closed = false;

  const runningCount = () => [...workers.values()].filter((w) => w.state === 'running').length;
  const canStart = () => runningCount() < maxConcurrent && freeMemory() >= minFree;

  function deliver(w: any, text: string) {
    w.lastActivity = now(); w.stallReported = false;
    w.proc.send(text).then((r: any) => {
      w.lastActivity = now();
      if (r.isError) onEvent({ worker: w.spec.id, kind: 'error', text: r.text });
      else onEvent({ worker: w.spec.id, kind: parseStatus(r.text).kind, text: r.text });
    }, () => { /* exit handler reports */ });
  }

  function launch(w: any, args: string[], firstMessage: string) {
    const proc = new ClaudeProcess({ exe, args, cwd: w.spec.cwd, env: w.spec.env, spawnFn: opts.spawnFn });
    w.proc = proc; w.state = 'running'; w.lastActivity = now(); w.stallReported = false;
    proc.on('event', (m: any) => {
      w.lastActivity = now(); w.stallReported = false;
      const p = describeEvent(m);
      if (p) { w.lastProgress = p; onEvent({ worker: w.spec.id, kind: 'progress', text: p }); }
    });
    proc.on('exit', (code: number | null) => {
      if (w.proc !== proc || w.state !== 'running') return;
      if (w.restarts < 1) {
        w.restarts++;
        onEvent({ worker: w.spec.id, kind: 'crashed', text: `restarting after exit ${code}` });
        launch(w, w.spec.resumeArgs, RESTART_NOTE);
      } else {
        w.state = 'failed';
        onEvent({ worker: w.spec.id, kind: 'failed', text: `stopped after crashing twice (exit ${code})` });
        pump();
      }
    });
    proc.start();
    deliver(w, firstMessage);
  }

  function pump() {
    if (closed) return;
    while (queue.length > 0 && canStart()) {
      const w = queue.shift();
      launch(w, w.spec.args, w.spec.brief);
    }
  }

  return {
    start(spec: WorkerSpec): 'running' | 'queued' {
      if (closed) throw new Error('worker pool is stopped');
      if (workers.get(spec.id)?.state === 'running') throw new Error(`worker ${spec.id} is already running`);
      const w = { spec, state: 'queued', restarts: 0, lastActivity: now(), lastProgress: '', stallReported: false, proc: null };
      workers.set(spec.id, w);
      if (canStart()) { launch(w, spec.args, spec.brief); return 'running'; }
      queue.push(w);
      return 'queued';
    },
    message(id: string, text: string) {
      const w = workers.get(id);
      if (!w || w.state !== 'running') throw new Error(`worker ${id} is not running`);
      deliver(w, text);
    },
    stop(id: string): boolean {
      const w = workers.get(id);
      if (!w) return false;
      const was = w.state;
      w.state = 'stopped';
      w.proc?.stop();
      const qi = queue.indexOf(w);
      if (qi >= 0) queue.splice(qi, 1);
      if (was === 'running') pump();
      return true;
    },
    status(id?: string) {
      return [...workers.values()].filter((w) => !id || w.spec.id === id)
        .map((w) => ({ id: w.spec.id, state: w.state as string, lastProgress: w.lastProgress as string, idleMs: now() - w.lastActivity }));
    },
    checkStalls() {
      for (const w of workers.values()) {
        if (w.state === 'running' && !w.stallReported && now() - w.lastActivity > stallMs) {
          w.stallReported = true;
          onEvent({ worker: w.spec.id, kind: 'stalled', text: `no progress for ${Math.round(stallMs / 60000)} minutes` });
        }
      }
      // A worker queued only for lack of memory is otherwise never retried (pump() normally runs
      // from an exit/stop), so with zero running workers it would wait forever. The hub calls
      // checkStalls() on a timer regardless, so piggyback the retry here.
      pump();
    },
    stopAll() { closed = true; for (const id of [...workers.keys()]) this.stop(id); },
  };
}
