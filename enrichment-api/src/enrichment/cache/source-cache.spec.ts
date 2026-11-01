import { describe, expect, it } from 'vitest';
import { loadCacheConfig, type CacheConfig } from './cache.config.js';
import { InMemoryCacheStore } from './in-memory-cache-store.js';
import { SnowflakeCacheStore } from './snowflake-cache-store.js';
import { SourceCache, type CacheEntry } from './source-cache.js';

const DAY_MS = 86_400_000;

function entry(overrides: Partial<CacheEntry<string>> = {}): CacheEntry<string> {
  return { source: 'zoominfo', key: ['company', '100'], read: (json) => (typeof json === 'string' ? json : null), keep: () => true, ...overrides };
}

function cache(store = new InMemoryCacheStore()) {
  return { store, scope: (refresh = false) => new SourceCache(loadCacheConfig({}), store).scope(refresh, 'test') };
}

const signal = () => new AbortController().signal;

describe('SourceCache', () => {
  it('fetches once and then returns the cached value with the time it was fetched', async () => {
    const { scope } = cache();
    let calls = 0;
    const fetch = () => Promise.resolve(`value ${++calls}`);

    const first = await scope().through(entry(), fetch, signal());
    const second = await scope().through(entry(), fetch, signal());

    expect(first).toEqual({ value: 'value 1', fetchedAt: null });
    expect(second.value).toBe('value 1');
    expect(second.fetchedAt).not.toBeNull();
    expect(calls).toBe(1);
  });

  it('fetches again when the entry is older than the TTL of its source', async () => {
    const { store, scope } = cache();
    await scope().through(entry(), () => Promise.resolve('old'), signal());
    for (const row of store.rows.values()) row.fetchedAtMs -= 8 * DAY_MS;

    const result = await scope().through(entry(), () => Promise.resolve('new'), signal());

    expect(result).toEqual({ value: 'new', fetchedAt: null });
  });

  it('skips the read on refresh but caches the new value', async () => {
    const { scope } = cache();
    await scope().through(entry(), () => Promise.resolve('old'), signal());

    expect(await scope(true).through(entry(), () => Promise.resolve('new'), signal())).toEqual({ value: 'new', fetchedAt: null });
    expect((await scope().through(entry(), () => Promise.resolve('unused'), signal())).value).toBe('new');
  });

  it('keeps different keys and sources apart', async () => {
    const { scope } = cache();
    await scope().through(entry(), () => Promise.resolve('company 100'), signal());

    const other = await scope().through(entry({ key: ['company', '200'] }), () => Promise.resolve('company 200'), signal());
    const dnb = await scope().through(entry({ source: 'dnb' }), () => Promise.resolve('dnb'), signal());

    expect([other.value, dnb.value]).toEqual(['company 200', 'dnb']);
  });

  it('does not cache values that are not kept, nor sources without a TTL', async () => {
    const { store, scope } = cache();

    await scope().through(entry({ keep: () => false }), () => Promise.resolve('partial'), signal());
    await scope().through(entry({ source: 'unknown' }), () => Promise.resolve('value'), signal());

    expect(store.rows.size).toBe(0);
  });

  it('treats a failed read as a miss', async () => {
    const store = new InMemoryCacheStore();
    store.read = () => Promise.reject(new Error('warehouse suspended'));
    const { scope } = cache(store);

    expect(await scope().through(entry(), () => Promise.resolve('fresh'), signal())).toEqual({ value: 'fresh', fetchedAt: null });
  });
});

describe('loadCacheConfig', () => {
  it('has a TTL per source, with shorter ones for news', () => {
    const { table, ttlsMs } = loadCacheConfig({});

    expect(table).toBeNull();
    expect(ttlsMs.get('web_page')).toBe(7 * DAY_MS);
    expect(ttlsMs.get('web_search:news')).toBe(DAY_MS);
    expect(ttlsMs.get('web_search:key-people')).toBe(7 * DAY_MS);
    expect(ttlsMs.get('web_search:company-facts')).toBe(30 * DAY_MS);
  });

  it('reads a topic TTL before the web search TTL, which overrides the defaults', () => {
    const { ttlsMs } = loadCacheConfig({ CACHE_TTL_WEB_SEARCH: '2d', CACHE_TTL_WEB_SEARCH_PERSON_NEWS: '12h', CACHE_TTL_DNB: '0' });

    expect(ttlsMs.get('web_search:company-facts')).toBe(2 * DAY_MS);
    expect(ttlsMs.get('web_search:person-news')).toBe(DAY_MS / 2);
    expect(ttlsMs.get('dnb')).toBe(0);
  });

  it('rejects durations without a unit', () => {
    expect(() => loadCacheConfig({ CACHE_TTL_ZOOMINFO: '7' })).toThrow(/CACHE_TTL_ZOOMINFO/);
  });
});

describe('SnowflakeCacheStore', () => {
  const config: CacheConfig = {
    ...loadCacheConfig({}),
    table: 'DB.CACHE.SOURCE_CACHE',
    accountUrl: 'https://acme.snowflakecomputing.com',
    auth: { type: 'pat', token: 'secret' },
  };

  function fakeSnowflake(rows: (string | null)[][]) {
    const statements: { statement: string; bindings?: Record<string, { value: string }> }[] = [];
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
      statements.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as (typeof statements)[number]);
      const body = { resultSetMetaData: { rowType: [{ name: 'RESULT' }, { name: 'FETCHED_MS' }] }, data: rows };
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    }) satisfies typeof fetch;
    return { statements, store: new SnowflakeCacheStore(config, fetchFn) };
  }

  it('reads the newest entry of a key and parses its JSON', async () => {
    const { statements, store } = fakeSnowflake([['{"matched":true}', '1767225600000']]);

    expect(await store.read('abc', signal())).toEqual({ value: { matched: true }, fetchedAtMs: 1767225600000 });
    expect(statements[0].statement).toMatch(/FROM DB\.CACHE\.SOURCE_CACHE WHERE CACHE_KEY = \? ORDER BY FETCHED_AT DESC LIMIT 1$/);
    expect(statements[0].bindings).toEqual({ '1': { type: 'TEXT', value: 'abc' } });
  });

  it('upserts the value as JSON', async () => {
    const { statements, store } = fakeSnowflake([]);

    await store.write('abc', 'zoominfo', { matched: true }, signal());

    expect(statements[0].statement).toMatch(/^MERGE INTO DB\.CACHE\.SOURCE_CACHE t USING \(SELECT \? AS CACHE_KEY, \? AS SOURCE, PARSE_JSON\(\?\) AS RESULT\) s/);
    expect(statements[0].bindings?.['3'].value).toBe('{"matched":true}');
  });
});
