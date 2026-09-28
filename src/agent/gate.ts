import { isAbsolute, normalize, resolve, sep } from 'node:path';

export type GateAction = 'allow' | 'ask' | 'deny';
export interface GateRequest { actor: string; tool: string; input: Record<string, unknown> }
export interface GateContext { cwd: string; readRoots: string[]; writeRoots: string[] }
export interface GateDecision { action: GateAction; reason: string; describe: string }

const RANK: Record<GateAction, number> = { allow: 0, ask: 1, deny: 2 };
const make = (action: GateAction, reason: string, describe: string): GateDecision => ({ action, reason, describe });
const worst = (a: GateDecision, b: GateDecision) => (RANK[b.action] > RANK[a.action] ? b : a);

const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const INTERNAL = new Set(['TodoWrite']);
const SECRET = /(^|[\s"'\\/~])\.(aws|ssh|npmrc|netrc|azure|kube)([\s"'\\/]|$)|\.git-credentials|\.docker[\\/]config\.json/i;
const ENV_FILE = /(^|[\s"'\\/])\.env(\.[\w-]+)?([\s"'\\/]|$)/i;
const ATLASSIAN_WRITE = /(create|edit|update|transition|add|delete|assign|comment|move|link|set|post|put|remove|upload)/i;
// $(, `, ${, %VAR%, $env:, or a bare $WORD-style shell variable reference.
const EXPANSION = /\$\(|`|\$\{|%[A-Za-z_]\w*%|\$env:|\$[A-Za-z_]\w*/i;
// Commands in ALLOW whose arguments can read arbitrary files and so need a path check (excludes pwd/echo).
const READ_CMD = /^(ls|dir|cat|type|head|tail|wc|findstr|grep)\b/i;

const ALLOW: RegExp[] = [
  /^(npm|pnpm|yarn)\s+(run\s+)?(test|build|lint)([\s:]|$)/i,
  /^node\s+(--[\w-]+(=\S+)?\s+)*--test\b/i,
  /^(npx\s+)?(vitest|jest|mocha|tsc)\b/i,
  /^(python\s+-m\s+)?pytest\b/i,
  /^dotnet\s+(test|build)\b/i,
  /^go\s+(test|build|vet)\b/i,
  /^git\s+(status|diff|log|show|add|commit|rev-parse|ls-files|branch\s+--show-current)\b/i,
  /^(ls|dir|cat|type|pwd|echo|head|tail|wc|findstr|grep)\b/i,
];

export function normPath(p: string, cwd: string): string {
  const expanded = p.replace(/^~(?=[\\/])/, process.env.USERPROFILE ?? '~');
  const abs = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
  return normalize(abs).replace(/[\\/]+$/, '').toLowerCase();
}

export function isInside(p: string, root: string, cwd: string): boolean {
  const a = normPath(p, cwd);
  const r = normPath(root, cwd);
  return a === r || a.startsWith(r + sep);
}

const insideAny = (p: string, roots: string[], cwd: string) => roots.some((r) => isInside(p, r, cwd));

export function splitCommand(cmd: string): string[] {
  return cmd.split(/&&|\|\||;|\||&|\r?\n/).map((s) => s.trim()).filter(Boolean);
}

function pathOf(input: Record<string, unknown>): string | undefined {
  for (const k of ['file_path', 'path', 'notebook_path']) {
    const v = input[k];
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

function readDecision(p: string, ctx: GateContext, tool: string): GateDecision {
  if (SECRET.test(p)) return make('deny', 'secrets folder', `${tool} ${p}`);
  if (insideAny(p, ctx.readRoots, ctx.cwd)) return make('allow', 'inside your projects', `${tool} ${p}`);
  return make('deny', 'outside your projects', `${tool} ${p}`);
}

function writeDecision(p: string | undefined, ctx: GateContext, isManager: boolean, tool: string): GateDecision {
  if (isManager) return make('deny', 'the manager does not edit files', `${tool} ${p ?? ''}`);
  if (!p) return make('ask', 'no file path', tool);
  if (SECRET.test(p)) return make('deny', 'secrets folder', `${tool} ${p}`);
  if (!insideAny(p, ctx.writeRoots, ctx.cwd)) return make('deny', 'outside the task worktree', `${tool} ${p}`);
  if (ENV_FILE.test(p)) return make('ask', 'touches a .env file', `${tool} ${p}`);
  return make('allow', 'inside the task worktree', `${tool} ${p}`);
}

function pathArgs(seg: string): string[] {
  return seg.split(/\s+/).slice(1).filter((t) => t && !t.startsWith('-') && !/^\/[a-z]$/i.test(t)).map((t) => t.replace(/^["']|["']$/g, ''));
}

function segment(seg: string, ctx: GateContext, cwd: string, isManager: boolean): GateDecision {
  const s = seg.trim();
  const low = s.toLowerCase();
  // Quotes/escapes are stripped before secret, env-file and path checks so they cannot be used to dodge them.
  const norm = s.replace(/['"`^]/g, '');
  if (SECRET.test(norm)) return make('deny', 'touches a secrets folder', s);
  if (EXPANSION.test(s)) return make('ask', 'uses shell expansion', s);
  if (/\bgit\s+push\b/.test(low) && /(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(low)) {
    if (/\b(main|master)\b/.test(low) || !/\bizza\//.test(low)) return make('deny', 'force-push outside an izza/ branch', s);
    return make('ask', 'force-push', s);
  }
  if (/\bgit\s+branch\s+(-d|--delete)\b/i.test(s)) {
    return /\bizza\//.test(s) ? make('ask', 'deletes a branch', s) : make('deny', 'deletes a non-izza branch', s);
  }
  if (/\bgit\s+push\s+\S+\s+(--delete\b|:)/.test(low)) return make('deny', 'deletes a remote branch', s);
  if (/\b(rm|rmdir|del|erase|remove-item)\b/.test(low) && /(\s-\w*r\w*\b|\s\/s\b|-recurse)/.test(low)) {
    const targets = pathArgs(s);
    if (targets.length === 0 || !targets.every((t) => insideAny(t, ctx.writeRoots, cwd))) return make('deny', 'recursive delete outside the worktree', s);
  }
  if (/\bgit\s+push\b/.test(low)) return make('ask', 'pushes to the remote', s);
  if (/\bgh\s+pr\b/.test(low)) return make('ask', 'pull request', s);
  if (/\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm)\b/.test(low)) return make('ask', 'network request', s);
  if (/\b(npm|pnpm|yarn)\s+(i|install|add|remove|uninstall|update|upgrade)\b|\bpip\s+install\b|\bwinget\b|\bchoco\b/.test(low)) return make('ask', 'installs packages', s);
  if (ENV_FILE.test(norm)) return make('ask', 'touches a .env file', s);
  if (/\b(aws|kubectl|terraform|prod|production)\b/.test(low)) return make('ask', 'mentions cloud or production', s);
  if (/\b(rm|rmdir|del|erase|remove-item|mv|move|move-item)\b/.test(low)) return make('ask', 'deletes or moves files', s);
  if (/>/.test(s)) return make('ask', 'writes via redirection', s);
  if (/^cd\s+/i.test(s)) {
    const target = s.replace(/^cd\s+(\/d\s+)?/i, '').replace(/^["']|["']$/g, '');
    return insideAny(target, ctx.readRoots, cwd) ? make('allow', 'change directory', s) : make('deny', 'directory outside your projects', s);
  }
  const readCmd = READ_CMD.exec(norm);
  if (readCmd) {
    const cmd = readCmd[1].toLowerCase();
    let args = pathArgs(norm);
    if ((cmd === 'findstr' || cmd === 'grep') && args.length > 0) args = args.slice(1);
    if (args.length === 0) {
      // No path argument (e.g. bare "dir", or "findstr /s /i token" with only a pattern): the
      // command reads the current directory, so that's what must be inside readRoots — same
      // fallback readDecision uses for a path-less Read tool call.
      if (!insideAny(cwd, ctx.readRoots, cwd)) return make('deny', 'outside your projects', s);
    } else {
      for (const a of args) {
        if (!insideAny(a, ctx.readRoots, cwd)) return make('deny', 'outside your projects', s);
      }
    }
  }
  if (ALLOW.some((re) => re.test(s))) {
    if (isManager && /\bgit\s+(add|commit)\b/.test(low)) return make('ask', 'the manager does not commit', s);
    return make('allow', 'safe command', s);
  }
  return make('ask', 'not on the safe list', s);
}

function bash(command: string, ctx: GateContext, isManager: boolean): GateDecision {
  if (!command.trim()) return make('ask', 'empty command', 'run an empty command');
  let cwd = ctx.cwd;
  let out = make('allow', 'safe command', '');
  for (const seg of splitCommand(command)) {
    out = worst(out, segment(seg, ctx, cwd, isManager));
    if (/^cd\s+/i.test(seg)) {
      const target = seg.replace(/^cd\s+(\/d\s+)?/i, '').trim().replace(/^["']|["']$/g, '');
      cwd = isAbsolute(target) ? target : resolve(cwd, target);
    }
  }
  return { ...out, describe: `run: ${command}` };
}

export function decide(req: GateRequest, ctx: GateContext): GateDecision {
  const { tool, input } = req;
  const isManager = req.actor === 'manager';
  if (tool === 'mcp__izza__permission') return make('deny', 'the gate cannot be called directly', tool);
  if (tool.startsWith('mcp__izza__')) return isManager ? make('allow', 'Izza tool', tool) : make('deny', 'workers cannot use Izza tools', tool);
  if (tool.startsWith('mcp__atlassian__')) {
    if (!isManager) return make('deny', 'workers do not use Jira directly', tool);
    return ATLASSIAN_WRITE.test(tool.slice('mcp__atlassian__'.length))
      ? make('ask', 'changes Jira', `${tool} ${JSON.stringify(input).slice(0, 160)}`)
      : make('allow', 'reads Jira', tool);
  }
  if (INTERNAL.has(tool)) return make('allow', 'internal bookkeeping', tool);
  if (READ_TOOLS.has(tool)) return readDecision(pathOf(input) ?? ctx.cwd, ctx, tool);
  if (WRITE_TOOLS.has(tool)) return writeDecision(pathOf(input), ctx, isManager, tool);
  if (tool === 'Bash') return bash(String(input.command ?? ''), ctx, isManager);
  return make('ask', 'unknown tool', `use ${tool}`);
}
