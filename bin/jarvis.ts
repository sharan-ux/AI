import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as readline from 'node:readline/promises';
import { bootstrap } from '../src/bootstrap.ts';
import { entryKey } from '../src/catalog.ts';
import { handleCommand } from '../src/core.ts';
import type { CoreContext } from '../src/core.ts';
import { loadMemory } from '../src/memory.ts';

let boot: ReturnType<typeof bootstrap>;
try {
  boot = bootstrap(resolve(import.meta.dirname, '..'));
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
const { paths, config, catalog, brains, status, warnings } = boot;
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const controller = new AbortController();
const { signal } = controller;
let busy = false;
let closed = false;
// Ctrl+C exits immediately; end of input (e.g. piped commands) waits for the running command to finish.
rl.on('SIGINT', () => process.exit(0));
rl.on('close', () => {
  closed = true;
  controller.abort();
  if (!busy) process.exit(0);
});

const print = (line: string) => console.log(line);
const ask = async (question: string): Promise<boolean | null> => {
  if (closed) return null;
  try {
    const answer = (await rl.question(`${question} (y/n) `, { signal })).trim();
    if (/^y(es)?$/i.test(answer)) return true;
    if (/^n(o)?$/i.test(answer)) return false;
    return null;
  } catch {
    return null;
  }
};
const ctx: CoreContext = { config, catalog, brains, runner: boot.runner, paths, ask, print };

const HELP = [
  'Type what you want in plain words, e.g. "start my day", "agentic dev", "open teams",',
  '"remember that my Jira board is PAY".',
  'Built-in: help, list (what I can do), memory (show memory file), status (brains), exit.',
].join('\n');

print(`Izza ready. ${status}`);
print("Type 'help' for examples.");
for (const warning of warnings) print(`! ${warning}`);

while (!closed) {
  let line: string;
  try {
    line = await rl.question('jarvis> ', { signal });
  } catch {
    break;
  }
  const command = line.trim().toLowerCase();
  if (command === 'exit' || command === 'quit') break;
  if (command === 'help') { print(HELP); continue; }
  if (command === 'status') { print(status); continue; }
  if (command === 'list') {
    for (const e of catalog.entries) print(`  ${entryKey(e.intent, e.target)}  - ${e.description}${e.confirm ? ' (asks first)' : ''}`);
    continue;
  }
  if (command === 'memory') {
    if (!existsSync(paths.memory)) {
      print('(memory is empty)');
    } else {
      try {
        print(readFileSync(paths.memory, 'utf8'));
      } catch (e) {
        print(`! memory file at ${paths.memory} could not be read: ${(e as Error).message}`);
      }
    }
    continue;
  }
  busy = true;
  try {
    await handleCommand(line, ctx);
  } catch (e) {
    print(`✗ Something went wrong: ${(e as Error).message}`);
  } finally {
    busy = false;
  }
}
rl.close();
process.exit(0);
