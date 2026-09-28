export type Intent = 'open_app' | 'open_workspace' | 'run_routine' | 'remember_fact' | 'unknown';

export interface Decision {
  intent: Intent;
  target?: string;
  confidence: number;
  source: string;
}

export interface CatalogEntry {
  intent: Exclude<Intent, 'unknown'>;
  target: string;
  description: string;
  confirm: boolean;
}

export interface Catalog {
  entries: CatalogEntry[];
}

export interface Brain {
  name: string;
  decide(text: string, catalog: Catalog, facts: string[]): Promise<Decision | null>;
}
