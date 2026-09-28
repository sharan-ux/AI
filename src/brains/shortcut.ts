import { normalizePhrase } from '../normalize.ts';
import type { Shortcut } from '../memory.ts';
import type { Brain, Catalog, Decision } from '../types.ts';

export function createShortcutBrain(getShortcuts: () => Map<string, Shortcut>): Brain {
  return {
    name: 'shortcut',
    async decide(text: string, _catalog: Catalog, _facts: string[]): Promise<Decision | null> {
      const hit = getShortcuts().get(normalizePhrase(text));
      return hit ? { intent: hit.intent, target: hit.target, confidence: 1, source: 'shortcut' } : null;
    },
  };
}
