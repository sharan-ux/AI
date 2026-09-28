import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createHub } from '../src/agent/hub.ts';
import { bootstrap } from '../src/bootstrap.ts';
import { createServer } from '../src/serve.ts';

// JSON-lines protocol for the Electron app. stdout carries protocol lines only.
const write = (msg: Record<string, unknown>) => { process.stdout.write(JSON.stringify(msg) + '\n'); };
console.log = (...args: unknown[]) => { process.stderr.write(args.join(' ') + '\n'); };
console.warn = console.log;

let boot: ReturnType<typeof bootstrap>;
try {
  boot = bootstrap(resolve(import.meta.dirname, '..'));
} catch (e) {
  write({ type: 'fatal', message: (e as Error).message });
  process.exit(1);
}

let hub: Awaited<ReturnType<typeof createHub>> | null = null;
const server = createServer(
  { config: boot.config, catalog: boot.catalog, brains: boot.brains, runner: boot.runner, paths: boot.paths },
  write,
  boot.config.agent.enabled ? { userTurn: (t) => (hub ? hub.userTurn(t) : Promise.reject(new Error('manager not ready'))) } : undefined,
);
write({ type: 'ready', status: boot.status, face: boot.config.face, voice: boot.config.voice });
for (const message of boot.warnings) write({ type: 'warning', message });

if (boot.config.agent.enabled) {
  const root = resolve(import.meta.dirname, '..');
  try {
    hub = await createHub({
      config: boot.config, root, dataDir: resolve(root, 'data'), memoryPath: boot.paths.memory, catalog: boot.catalog,
      askUser: (q, kind) => server.askUser(q, kind), say: (t) => server.say(t), progress: () => server.progress(),
    });
  } catch (e) {
    write({ type: 'warning', message: `Izza's manager couldn't start: ${(e as Error).message}` });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => server.handleLine(line));
rl.on('close', async () => { server.close(); await server.idle(); hub?.close(); process.exit(0); });
