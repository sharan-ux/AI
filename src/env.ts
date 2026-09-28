export interface EnvSettings {
  jevEnabled: boolean;
  openrouterKey?: string;
  jevUrl: string;
  jevModel: string;
  jevThreshold: number;
  llmEnabled: boolean;
  llmModel?: string;
  claudeModel: string;
}

type Env = Record<string, string | undefined>;

function flag(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() ?? '');
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadEnv(env: Env = process.env): EnvSettings {
  const threshold = Number(env.JEV_THRESHOLD ?? '0.75');
  return {
    jevEnabled: flag(env.JEV_ENABLED),
    openrouterKey: text(env.OPENROUTER_API_KEY),
    jevUrl: text(env.JEV_URL) ?? 'https://openrouter.ai/api/alpha/decisions',
    jevModel: text(env.JEV_MODEL) ?? 'typesafe/jev-1.13',
    jevThreshold: Number.isFinite(threshold) && threshold > 0 && threshold <= 1 ? threshold : 0.75,
    llmEnabled: flag(env.OPENROUTER_LLM_ENABLED),
    llmModel: text(env.OPENROUTER_MODEL),
    claudeModel: text(env.CLAUDE_BRAIN_MODEL) ?? 'haiku',
  };
}
