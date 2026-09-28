import { spawn } from 'node:child_process';
import type { JarvisConfig } from './config.ts';
import type { CatalogEntry } from './types.ts';

export type Launcher = (exe: string, args: string[]) => Promise<void>;

export interface StepResult {
  label: string;
  ok: boolean;
  message?: string;
}

export interface Command {
  what: string;
  exe: string;
  args: string[];
}

export interface Runner {
  run(entry: CatalogEntry): Promise<StepResult[]>;
}

// Spawns by full path with an args array - never through a shell.
export const launchDetached: Launcher = (exe, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });

export function appCommand(config: JarvisConfig, key: string): Command | null {
  const app = config.apps[key];
  if (app.url) return { what: 'Chrome', exe: config.chrome.path, args: [`--profile-directory=${config.chrome.profile}`, app.url] };
  if (app.exe) return { what: key, exe: app.exe, args: app.args ?? [] };
  return null;
}

export function workspaceCommands(config: JarvisConfig, key: string): Command[] {
  const ws = config.workspaces[key];
  const commands: Command[] = [{ what: 'VS Code', exe: config.vscode.path, args: [ws.folder] }];
  if (ws.claude.mode !== 'none') {
    const claudeArgs = ws.claude.mode === 'resume' ? ['--resume', ws.claude.sessionId ?? ''] : ['--continue'];
    commands.push({ what: 'Windows Terminal', exe: config.terminal.path, args: ['-d', ws.folder, config.claude.path, ...claudeArgs] });
  }
  return commands;
}

function explain(error: unknown, command: Command): string {
  const e = error as { code?: string; message?: string };
  if (e?.code === 'ENOENT') return `${command.what} not found at ${command.exe} - check jarvis.config.json`;
  return `${command.what} failed to start: ${e?.message ?? String(error)}`;
}

export function createRunner(config: JarvisConfig, launch: Launcher = launchDetached): Runner {
  async function runCommands(label: string, commands: Command[]): Promise<StepResult> {
    const errors: string[] = [];
    for (const command of commands) {
      try {
        await launch(command.exe, command.args);
      } catch (e) {
        errors.push(explain(e, command));
      }
    }
    return errors.length > 0 ? { label, ok: false, message: errors.join('; ') } : { label, ok: true };
  }

  async function openApp(key: string): Promise<StepResult> {
    const command = appCommand(config, key);
    if (!command) return { label: key, ok: false, message: `${key} has no URL configured - set apps.${key}.url in jarvis.config.json` };
    return runCommands(key, [command]);
  }

  async function openWorkspace(key: string): Promise<StepResult> {
    return runCommands(key, workspaceCommands(config, key));
  }

  return {
    async run(entry: CatalogEntry): Promise<StepResult[]> {
      switch (entry.intent) {
        case 'open_app':
          return [await openApp(entry.target)];
        case 'open_workspace':
          return [await openWorkspace(entry.target)];
        case 'run_routine': {
          const results: StepResult[] = [];
          for (const step of config.routines[entry.target].steps) {
            const colon = step.indexOf(':');
            const kind = step.slice(0, colon);
            const key = step.slice(colon + 1);
            results.push(kind === 'app' ? await openApp(key) : await openWorkspace(key));
          }
          return results;
        }
        default:
          throw new Error(`runner cannot handle ${entry.intent}`);
      }
    },
  };
}
