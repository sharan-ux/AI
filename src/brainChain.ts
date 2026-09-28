import type { Brain, Catalog, Decision } from './types.ts';

export async function decide(
  text: string,
  brains: Brain[],
  catalog: Catalog,
  facts: string[],
): Promise<{ decision: Decision; errors: string[] }> {
  const errors: string[] = [];
  for (const brain of brains) {
    try {
      const decision = await brain.decide(text, catalog, facts);
      if (decision) return { decision, errors };
    } catch (e) {
      errors.push(`${brain.name}: ${(e as Error).message}`);
    }
  }
  return { decision: { intent: 'unknown', confidence: 0, source: 'none' }, errors };
}
