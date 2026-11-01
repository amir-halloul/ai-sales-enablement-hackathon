import { loadOpenAiConnection, readModelName, type OpenAiConnection } from '../../openai/openai.config.js';

export interface ConsolidationConfig extends OpenAiConnection {
  enabled: boolean;
  /** OpenAI model that consolidates the news and products lists. */
  model: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = 'gpt-6-luna';

export function loadConsolidationConfig(env: Env = process.env): ConsolidationConfig {
  return { enabled: readEnabled(env), ...loadOpenAiConnection(env), model: readModelName(env, 'CONSOLIDATION_MODEL', DEFAULT_MODEL) };
}

function readEnabled(env: Env): boolean {
  const raw = env.CONSOLIDATION_ENABLED?.trim().toLowerCase();
  if (!raw || ['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error('CONSOLIDATION_ENABLED must be true or false');
}
