import { entryKey, findEntry } from '../catalog.ts';
import type { Brain, Catalog, Decision, Intent } from '../types.ts';

export function buildJevRequest(text: string, catalog: Catalog, facts: string[], model: string): object {
  const criteria: Record<string, string> = {};
  for (const e of catalog.entries) {
    if (e.intent !== 'remember_fact') criteria[entryKey(e.intent, e.target)] = e.description;
  }
  criteria.unknown = 'The command matches none of the other options.';
  const state = facts.length > 0
    ? `Known facts:\n${facts.map((f) => `- ${f}`).join('\n')}\n\nUser command: ${text}`
    : `User command: ${text}`;
  return {
    model,
    state,
    questions: {
      action: { type: 'choice', instructions: 'Which action does the user want Jarvis to perform?', criteria },
    },
  };
}

export function parseJevResponse(body: any, catalog: Catalog, threshold: number): Decision | null {
  const answer = body?.answers?.action;
  if (!answer || typeof answer.choice !== 'string' || answer.choice === 'unknown') return null;
  const p = answer.probabilities?.[answer.choice] ?? answer.confidence;
  if (typeof p !== 'number' || p < threshold) return null;
  const colon = answer.choice.indexOf(':');
  if (colon < 0) return null;
  const intent = answer.choice.slice(0, colon);
  const target = answer.choice.slice(colon + 1);
  if (intent === 'remember_fact' || !findEntry(catalog, intent, target)) return null;
  return { intent: intent as Intent, target, confidence: p, source: 'jev' };
}

export interface JevOptions {
  url: string;
  model: string;
  apiKey?: string;
  threshold: number;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createJevBrain({ url, model, apiKey, threshold, fetchFn = fetch, timeoutMs = 5000 }: JevOptions): Brain {
  return {
    name: 'jev',
    async decide(text: string, catalog: Catalog, facts: string[]): Promise<Decision | null> {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (apiKey && new URL(url).hostname === 'openrouter.ai') headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetchFn(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildJevRequest(text, catalog, facts, model)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Jev HTTP ${res.status}`);
      return parseJevResponse(await res.json(), catalog, threshold);
    },
  };
}
