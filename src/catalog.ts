import type { Catalog, CatalogEntry } from './types.ts';
import type { JarvisConfig } from './config.ts';

export const FACT_TARGET = '*';

export function buildCatalog(config: JarvisConfig): Catalog {
  const entries: CatalogEntry[] = [];
  for (const [key, app] of Object.entries(config.apps)) {
    entries.push({ intent: 'open_app', target: key, description: `Open ${app.description}`, confirm: app.confirm });
  }
  for (const [key, ws] of Object.entries(config.workspaces)) {
    entries.push({ intent: 'open_workspace', target: key, description: `Open workspace: ${ws.description}`, confirm: ws.confirm });
  }
  for (const [key, routine] of Object.entries(config.routines)) {
    entries.push({ intent: 'run_routine', target: key, description: `Run routine: ${routine.description}`, confirm: routine.confirm });
  }
  entries.push({
    intent: 'remember_fact',
    target: FACT_TARGET,
    description: 'Remember a fact the user states, e.g. "remember that my Jira board is PAY"',
    confirm: true,
  });
  return { entries };
}

export function entryKey(intent: string, target: string): string {
  return `${intent}:${target}`;
}

export function findEntry(catalog: Catalog, intent: string, target: string): CatalogEntry | undefined {
  if (intent === 'remember_fact') return catalog.entries.find((e) => e.intent === 'remember_fact');
  return catalog.entries.find((e) => e.intent === intent && e.target === target);
}
