import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { buildSystemPrompt, decisionSchema, parseChoice } from './prompt.ts';
import type { Brain, Catalog, Decision } from '../types.ts';

export type ProcessRunner = (exe: string, args: string[], input: string, timeoutMs: number) => Promise<string>;

export const runProcess: ProcessRunner = (exe, args, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    // cwd = temp dir so the brain call never picks up a project's CLAUDE.md or settings.
    const child = spawn(exe, args, { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let settled = false;
    const settle = (fn: (v: any) => void, value: any) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        fn(value);
      }
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(reject, new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
    child.on('error', (e) => {
      settle(reject, e);
    });
    child.on('close', (code) => {
      if (code === 0) settle(resolve, out);
      else settle(reject, new Error(`exited with code ${code}: ${(err || out).trim().slice(0, 300)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

export function buildClaudeArgs(model: string, systemPrompt: string, schema: object): string[] {
  return [
    '-p', '--model', model,
    '--tools', '',
    '--no-session-persistence',
    '--output-format', 'json',
    '--system-prompt', systemPrompt,
    '--json-schema', JSON.stringify(schema),
  ];
}

export function parseClaudeOutput(stdout: string, catalog: Catalog): Decision {
  let body: any;
  try {
    body = JSON.parse(stdout);
  } catch {
    throw new Error('claude output was not JSON: ' + stdout.trim().slice(0, 200));
  }
  if (body?.is_error) throw new Error(`claude reported an error: ${String(body.result).slice(0, 200)}`);
  let value: unknown = body?.structured_output;
  if (value === undefined && typeof body?.result === 'string') {
    try {
      value = JSON.parse(body.result);
    } catch {
      value = undefined;
    }
  }
  if (value === undefined) {
    throw new Error('claude returned no decision: ' + String(body?.result ?? '').slice(0, 200));
  }
  return parseChoice(value, catalog, 'claude-code');
}

export interface ClaudeCodeOptions {
  exe: string;
  model: string;
  run?: ProcessRunner;
  timeoutMs?: number;
}

export function createClaudeCodeBrain({ exe, model, run = runProcess, timeoutMs = 60000 }: ClaudeCodeOptions): Brain {
  return {
    name: 'claude-code',
    async decide(text: string, catalog: Catalog, facts: string[]): Promise<Decision | null> {
      const args = buildClaudeArgs(model, buildSystemPrompt(catalog, facts), decisionSchema(catalog));
      return parseClaudeOutput(await run(exe, args, text, timeoutMs), catalog);
    },
  };
}
