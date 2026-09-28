import { loadMemory } from '../memory.ts';
import { createClaudeCodeBrain } from './claudeCode.ts';
import type { ProcessRunner } from './claudeCode.ts';
import { createJevBrain } from './jev.ts';
import { createOpenRouterBrain } from './openrouter.ts';
import { createShortcutBrain } from './shortcut.ts';
import type { EnvSettings } from '../env.ts';
import type { JarvisConfig } from '../config.ts';
import type { Brain, Catalog } from '../types.ts';

export interface BrainDeps {
  fetchFn?: typeof fetch;
  run?: ProcessRunner;
}

export function buildBrains(
  env: EnvSettings,
  config: JarvisConfig,
  catalog: Catalog,
  memoryPath: string,
  deps: BrainDeps = {},
): { brains: Brain[]; status: string; warnings: string[] } {
  const brains: Brain[] = [createShortcutBrain(() => loadMemory(memoryPath, catalog).shortcuts)];
  const warnings: string[] = [];

  let jev = 'off';
  if (env.jevEnabled) {
    const needsKey = env.jevUrl.startsWith('https://openrouter.ai');
    if (env.openrouterKey || !needsKey) {
      brains.push(createJevBrain({
        url: env.jevUrl, model: env.jevModel, apiKey: env.openrouterKey, threshold: env.jevThreshold, fetchFn: deps.fetchFn,
      }));
      jev = `on (${env.jevModel}, >= ${env.jevThreshold})`;
    } else {
      warnings.push('JEV_ENABLED is set but OPENROUTER_API_KEY is missing - Jev stays off.');
    }
  }

  let llm = 'off';
  if (env.llmEnabled) {
    if (env.openrouterKey && env.llmModel) {
      brains.push(createOpenRouterBrain({ apiKey: env.openrouterKey, model: env.llmModel, fetchFn: deps.fetchFn }));
      llm = `on (${env.llmModel})`;
    } else {
      warnings.push('OPENROUTER_LLM_ENABLED is set but OPENROUTER_API_KEY or OPENROUTER_MODEL is missing - OpenRouter LLM stays off.');
    }
  }

  brains.push(createClaudeCodeBrain({ exe: config.claude.path, model: env.claudeModel, run: deps.run }));
  const chain = brains.map((b) => b.name).join(' -> ');
  return { brains, status: `brains: ${chain} | jev: ${jev} | openrouter llm: ${llm} | claude model: ${env.claudeModel}`, warnings };
}
