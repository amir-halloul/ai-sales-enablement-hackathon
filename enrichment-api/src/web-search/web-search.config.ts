import { loadOpenAiConnection, readModelName, type OpenAiConnection } from '../openai/openai.config.js';

export const WEB_SEARCH_CONFIG = Symbol('WEB_SEARCH_CONFIG');
export const WEB_SEARCH_FETCH = Symbol('WEB_SEARCH_FETCH');

export interface WebSearchConfig extends OpenAiConnection {
  enabled: boolean;
  /** OpenAI model that runs the web_search tool. */
  model: string;
}

type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = 'gpt-6-luna';

export function loadWebSearchConfig(env: Env = process.env): WebSearchConfig {
  return {
    enabled: readBoolean(env, 'WEB_SEARCH_ENABLED', true),
    ...loadOpenAiConnection(env),
    model: readModelName(env, 'WEB_SEARCH_MODEL', DEFAULT_MODEL),
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}
