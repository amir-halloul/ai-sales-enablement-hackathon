import { loadOpenAiConnection, readModelName, type OpenAiConnection } from '../openai/openai.config.js';

export const WEBSITE_CONFIG = Symbol('WEBSITE_CONFIG');
/** Fetches one page of a company website, with the SSRF guard. */
export const WEBSITE_PAGE_FETCH = Symbol('WEBSITE_PAGE_FETCH');
/** Calls the OpenAI REST API. */
export const WEBSITE_OPENAI_FETCH = Symbol('WEBSITE_OPENAI_FETCH');
export const WEBSITE_PROMPTS = Symbol('WEBSITE_PROMPTS');

export interface WebsiteConfig extends OpenAiConnection {
  enabled: boolean;
  /** OpenAI model that extracts the company data from the crawled pages. */
  model: string;
  maxPages: number;
  crawlTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const DEFAULT_MODEL = 'gpt-6-luna';
const DEFAULT_MAX_PAGES = 25;
const DEFAULT_CRAWL_TIMEOUT_MS = 25_000;

export function loadWebsiteConfig(env: Env = process.env): WebsiteConfig {
  return {
    enabled: readBoolean(env, 'WEBSITE_ENABLED', true),
    ...loadOpenAiConnection(env),
    model: readModelName(env, 'WEBSITE_EXTRACTION_MODEL', DEFAULT_MODEL),
    maxPages: readInteger(env, 'WEBSITE_MAX_PAGES', DEFAULT_MAX_PAGES, { min: 1, max: 100 }),
    crawlTimeoutMs: readInteger(env, 'WEBSITE_CRAWL_TIMEOUT_MS', DEFAULT_CRAWL_TIMEOUT_MS, { min: 1_000, max: 120_000 }),
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

function readInteger(env: Env, name: string, fallback: number, range: { min: number; max: number }): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new Error(`${name} must be an integer from ${range.min} to ${range.max}`);
  }
  return value;
}
