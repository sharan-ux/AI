import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export interface ClaudeArgsOptions {
  sessionId: string; resume: boolean; model?: string; mcpConfigPath: string; systemPromptFile: string; addDirs: string[]; disallowedTools: string[];
}
export interface TurnResult { text: string; isError: boolean; sessionId: string }
type SpawnFn = typeof spawn;

export function buildClaudeArgs(o: ClaudeArgsOptions): string[] {
  const a = ['-p', '--permission-mode', 'default', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'];
  a.push(...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]));
  if (o.model) a.push('--model', o.model);
  a.push('--mcp-config', o.mcpConfigPath, '--strict-mcp-config', '--permission-prompt-tool', 'mcp__izza__permission');
  a.push('--append-system-prompt-file', o.systemPromptFile);
  for (const d of o.addDirs) a.push('--add-dir', d);
  if (o.disallowedTools.length > 0) a.push('--disallowedTools', ...o.disallowedTools);
  return a;
}

export function userTurn(text: string): string {
  return `${JSON.stringify({ type: 'user', message: { role: 'user', content: text } })}\n`;
}

export function describeEvent(m: any): string | null {
  if (m?.type !== 'assistant' || !Array.isArray(m.message?.content)) return null;
  for (const block of m.message.content) {
    if (block?.type === 'tool_use') {
      const detail = block.input?.command ?? block.input?.file_path ?? block.input?.pattern ?? '';
      return `${block.name} ${String(detail)}`.trim().slice(0, 160);
    }
  }
  const text = m.message.content.find((b: any) => b?.type === 'text')?.text;
  return typeof text === 'string' && text.trim() ? text.trim().split(/\r?\n/)[0].slice(0, 160) : null;
}

export class ClaudeProcess extends EventEmitter {
  exe: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv | undefined; spawnFn: SpawnFn;
  child: any = null;
  waiters: { resolve: (r: TurnResult) => void; reject: (e: Error) => void }[] = [];
  stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(o: { exe: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; spawnFn?: SpawnFn }) {
    super();
    this.exe = o.exe; this.args = o.args; this.cwd = o.cwd; this.env = o.env; this.spawnFn = o.spawnFn ?? spawn;
  }

  get running(): boolean { return this.child !== null; }

  start(): void {
    const child = this.spawnFn(this.exe, this.args, { cwd: this.cwd, env: this.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    child.stdin?.on('error', () => {});
    createInterface({ input: child.stdout! }).on('line', (line) => {
      let m: any;
      try { m = JSON.parse(line); } catch { return; }
      this.emit('event', m);
      if (m.type === 'result') {
        const r: TurnResult = { text: String(m.result ?? ''), isError: Boolean(m.is_error) || m.subtype !== 'success', sessionId: String(m.session_id ?? '') };
        this.waiters.shift()?.resolve(r);
        this.emit('result', r);
      }
    });
    child.stderr?.on('data', (d: Buffer) => this.emit('log', String(d)));
    child.on('error', (e: Error) => this.failAll(e));
    child.on('close', (code: number | null) => {
      if (this.child === child) this.child = null;
      if (this.stopTimer) { clearTimeout(this.stopTimer); this.stopTimer = null; }
      this.failAll(new Error(`claude exited (${code})`));
      this.emit('exit', code);
    });
  }

  send(text: string): Promise<TurnResult> {
    if (!this.child) return Promise.reject(new Error('claude is not running'));
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
      this.child.stdin.write(userTurn(text));
    });
  }

  failAll(e: Error): void {
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    if (!child) return;
    child.stdin?.end();
    this.stopTimer = setTimeout(() => child.kill(), 5000);
    this.stopTimer.unref?.();
  }
}
