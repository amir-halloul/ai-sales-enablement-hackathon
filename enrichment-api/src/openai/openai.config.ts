export interface OpenAiConnection {
  /** e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string | null;
  /** Reasoning effort sent to reasoning models; null keeps the model's default. */
  reasoningEffort: string | null;
}

type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_REASONING_EFFORT = 'low';

/** OPENAI_API_KEY, plus OPENAI_BASE_URL for an OpenAI-compatible gateway. OPENAI_REASONING_EFFORT=default omits the setting. */
export function loadOpenAiConnection(env: Env = process.env): OpenAiConnection {
  const baseUrl = env.OPENAI_BASE_URL?.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  if (!/^https:\/\/[^\s?#]+$/i.test(baseUrl)) {
    throw new Error('OPENAI_BASE_URL must be an https URL such as https://api.openai.com/v1');
  }
  const effort = env.OPENAI_REASONING_EFFORT?.trim().toLowerCase() || DEFAULT_REASONING_EFFORT;
  if (!/^[a-z]+$/.test(effort)) throw new Error('OPENAI_REASONING_EFFORT must be a reasoning effort such as low');
  return { baseUrl, apiKey: env.OPENAI_API_KEY?.trim() || null, reasoningEffort: effort === 'default' ? null : effort };
}

export function openAiAuthHeaders(apiKey: string): Record<string, string> {
  return { authorization: `Bearer ${apiKey}` };
}

export function readModelName(env: Env, name: string, fallback: string): string {
  const model = env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(model)) throw new Error(`${name} must be an OpenAI model name such as ${fallback}`);
  return model;
}
