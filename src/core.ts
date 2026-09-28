import { decide } from './brainChain.ts';
import { appendDecision } from './decisionLog.ts';
import type { Outcome } from './decisionLog.ts';
import { checkDecision } from './guard.ts';
import { appendFact, appendShortcut, loadMemory } from './memory.ts';
import { normalizePhrase } from './normalize.ts';
import { countKey, markDeclined, recordUse } from './phraseCounts.ts';
import type { Runner, StepResult } from './actions.ts';
import type { JarvisConfig } from './config.ts';
import type { Brain, Catalog, CatalogEntry, Decision } from './types.ts';

export interface CommandSummary {
  decision: Decision;
  outcome: Outcome | 'none';
  results: StepResult[];
  errors: string[];
}

export interface CoreContext {
  config: JarvisConfig;
  catalog: Catalog;
  brains: Brain[];
  runner: Runner;
  paths: { memory: string; counts: string; log: string };
  ask(question: string): Promise<boolean | null>;
  print(line: string): void;
}

function describe(decision: Decision): string {
  if (decision.intent === 'remember_fact') return `remember_fact "${decision.target}"`;
  return `${decision.intent} ${decision.target ?? ''}`.trim();
}

export async function handleCommand(text: string, ctx: CoreContext): Promise<CommandSummary> {
  const input = text.trim();
  if (!input) return { decision: { intent: 'unknown', confidence: 0, source: 'none' }, outcome: 'none', results: [], errors: [] };

  const memory = loadMemory(ctx.paths.memory, ctx.catalog);
  const { decision, errors } = await decide(input, ctx.brains, ctx.catalog, memory.facts);
  const finish = (outcome: Outcome, results: StepResult[] = []): CommandSummary => {
    appendDecision(ctx.paths.log, {
      ts: new Date().toISOString(),
      text: input,
      source: decision.source,
      intent: decision.intent,
      target: decision.target,
      confidence: decision.confidence,
      outcome,
    });
    return { decision, outcome, results, errors };
  };

  if (decision.intent === 'unknown') {
    ctx.print("I don't know how to do that yet. Type 'list' to see what I can do.");
    for (const error of errors) ctx.print(`  (brain error - ${error})`);
    return finish('unknown');
  }

  ctx.print(`→ ${describe(decision)}  (${decision.source}, ${decision.confidence.toFixed(2)})`);

  const guard = checkDecision(decision, ctx.catalog);
  if (!guard.ok) {
    ctx.print(`✗ Refused: ${guard.reason}`);
    return finish('rejected');
  }
  const { entry } = guard;

  if (entry.confirm) {
    const question = entry.intent === 'remember_fact' ? `Remember "${decision.target}"?` : `${entry.description}. Proceed?`;
    if ((await ctx.ask(question)) !== true) {
      ctx.print('Cancelled.');
      return finish('declined');
    }
  }

  if (entry.intent === 'remember_fact') {
    appendFact(ctx.paths.memory, decision.target ?? '');
    ctx.print('✓ Remembered.');
    return finish('executed');
  }

  const results = await ctx.runner.run(entry);
  const succeeded = results.filter((r) => r.ok).map((r) => `✓ ${r.label}`);
  if (succeeded.length > 0) ctx.print(`  ${succeeded.join('  ')}`);
  for (const r of results.filter((r) => !r.ok)) ctx.print(`  ✗ ${r.label}: ${r.message}`);
  const summary = finish(results.every((r) => r.ok) ? 'executed' : 'failed', results);

  if (decision.source !== 'shortcut' && results.some((r) => r.ok)) {
    await maybeSuggestShortcut(input, entry, ctx);
  }
  return summary;
}

async function maybeSuggestShortcut(input: string, entry: CatalogEntry, ctx: CoreContext): Promise<void> {
  const phrase = normalizePhrase(input);
  if (!phrase) return;
  const key = countKey(phrase, entry.intent, entry.target);
  const { count, suggest } = recordUse(ctx.paths.counts, key, ctx.config.memory.suggestAfter, ctx.print);
  if (!suggest) return;
  const answer = await ctx.ask(`You've said "${phrase}" ${count} times. Remember it as a shortcut?`);
  if (answer === true) {
    appendShortcut(ctx.paths.memory, phrase, entry.intent, entry.target);
    ctx.print(`✓ Saved shortcut: "${phrase}" → ${entry.intent} ${entry.target}`);
  } else if (answer === false) {
    markDeclined(ctx.paths.counts, key, ctx.print);
    ctx.print("OK, I won't ask about that again.");
  }
}
