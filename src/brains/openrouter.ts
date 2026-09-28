import { buildSystemPrompt, decisionSchema, parseChoice } from './prompt.ts';
import type { Brain, Catalog, Decision } from '../types.ts';

export interface OpenRouterOptions {
  apiKey: string;
  model: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export function createOpenRouterBrain({ apiKey, model, fetchFn = fetch, timeoutMs = 15000 }: OpenRouterOptions): Brain {
  return {
    name: 'openrouter',
    async decide(text: string, catalog: Catalog, facts: string[]): Promise<Decision | null> {
      const res = await fetchFn('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: buildSystemPrompt(catalog, facts) },
            { role: 'user', content: text },
          ],
          response_format: { type: 'json_schema', json_schema: { name: 'decision', schema: decisionSchema(catalog) } },
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}`);
      const body: any = await res.json();
      let value: unknown;
      try {
        value = JSON.parse(body?.choices?.[0]?.message?.content ?? '');
      } catch {
        return null;
      }
      const decision = parseChoice(value, catalog, 'openrouter');
      return decision.intent === 'unknown' ? null : decision;
    },
  };
}
