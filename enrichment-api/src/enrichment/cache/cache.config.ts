import type { SnowflakeSqlConfig } from '../../snowflake/snowflake-sql.client.js';
import { loadSnowflakeSqlConfig, readTableName } from '../../snowflake/snowflake-sql.config.js';
import { COMPANY_TOPICS, PERSON_TOPICS } from '../providers/web-search.topics.js';

export const CACHE_CONFIG = Symbol('CACHE_CONFIG');

export interface CacheConfig extends SnowflakeSqlConfig {
  /** Fully qualified name of the cache table; null turns the cache off. */
  table: string | null;
  /** Time to live in ms per source; a source without one (or with 0) is not cached. */
  ttlsMs: Map<string, number>;
}

type Env = Record<string, string | undefined>;

/** Web search topics are cached one by one, as "web_search:<topic>", and fall back to the web_search TTL. */
const SOURCES = [
  'zoominfo',
  'dnb',
  'web_page',
  'consolidation',
  ...[...COMPANY_TOPICS, ...PERSON_TOPICS].map((topic) => `web_search:${topic.name}`),
];

/** News changes daily; facts such as the founding year or social profiles rarely change. */
const DEFAULT_TTLS: Record<string, string> = {
  zoominfo: '7d',
  dnb: '30d',
  web_page: '7d',
  consolidation: '30d',
  web_search: '7d',
  'web_search:news': '1d',
  'web_search:person-news': '1d',
  'web_search:company-facts': '30d',
  'web_search:social-profiles': '30d',
  'web_search:products-and-market': '30d',
  'web_search:person-career': '30d',
  'web_search:person-social-profiles': '30d',
};

const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function loadCacheConfig(env: Env = process.env): CacheConfig {
  const sql = loadSnowflakeSqlConfig(env);
  const ttlsMs = new Map<string, number>();
  for (const source of SOURCES) ttlsMs.set(source, ttlFor(source, env));
  return { ...sql, table: readTableName(env, 'SOURCE_CACHE_TABLE', sql), ttlsMs };
}

/** The source's own variable wins, then its group's (CACHE_TTL_WEB_SEARCH for every topic), then the defaults. */
function ttlFor(source: string, env: Env): number {
  const group = source.split(':')[0];
  for (const name of [source, group]) {
    const variable = ttlVariable(name);
    const value = env[variable]?.trim();
    if (value) return parseDuration(value, variable);
  }
  const fallback = DEFAULT_TTLS[source] ?? DEFAULT_TTLS[group];
  return fallback ? parseDuration(fallback, 'default TTL') : 0;
}

/** "web_search:person-news" is set with CACHE_TTL_WEB_SEARCH_PERSON_NEWS. */
function ttlVariable(source: string): string {
  return `CACHE_TTL_${source.toUpperCase().replace(/[:-]/g, '_')}`;
}

function parseDuration(value: string, variable: string): number {
  if (value === '0') return 0;
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) throw new Error(`${variable} must be a duration such as 7d, 12h or 30m, or 0 to turn caching off`);
  return Number(match[1]) * UNIT_MS[match[2]];
}
