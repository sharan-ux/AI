import { resolve } from 'node:path';
import { createRunner } from './actions.ts';
import { buildBrains } from './brains/index.ts';
import { buildCatalog } from './catalog.ts';
import { loadConfig } from './config.ts';
import { loadEnv } from './env.ts';
import { loadMemory } from './memory.ts';

// Shared start-up for the REPL and serve entry points. Throws if the config is invalid.
export function bootstrap(root: string) {
  const paths = {
    config: resolve(root, 'jarvis.config.json'),
    memory: resolve(root, 'jarvis-memory.txt'),
    counts: resolve(root, 'data', 'phrase-counts.json'),
    log: resolve(root, 'data', 'training-log.jsonl'),
  };
  const config = loadConfig(paths.config);
  const catalog = buildCatalog(config);
  const { brains, status, warnings } = buildBrains(loadEnv(), config, catalog, paths.memory);
  return {
    paths, config, catalog, brains, status,
    warnings: [...warnings, ...loadMemory(paths.memory, catalog).warnings],
    runner: createRunner(config),
  };
}
