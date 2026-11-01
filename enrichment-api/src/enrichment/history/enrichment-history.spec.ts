import { describe, expect, it } from 'vitest';
import type { EnrichResponse } from '../enrichment.types.js';
import { EnrichmentHistory, loadHistoryConfig, type HistoryConfig } from './enrichment-history.js';

const CONFIG: HistoryConfig = {
  table: 'DB.CACHE.ENRICHMENT_HISTORY',
  warehouse: 'CACHE_WH',
  accountUrl: 'https://acme.snowflakecomputing.com',
  auth: { type: 'pat', token: 'secret' },
};

function response(overrides: Partial<Record<string, unknown>> = {}): EnrichResponse {
  return {
    entityId: 'ent_1',
    entityType: 'company',
    name: { value: 'Example Corp', confidence: 'high', sources: [] },
    completeness: 'complete',
    warnings: [],
    providers: [{ provider: 'zoominfo', status: 'ok', error: null, retrievedAt: '2026-01-01T00:00:00.000Z' }],
    retrievedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as unknown as EnrichResponse;
}

function fakeSnowflake(status = 200) {
  const statements: { statement: string; bindings: Record<string, { value: string }> }[] = [];
  const fetchFn = ((_input: string | URL | Request, init?: RequestInit) => {
    statements.push(JSON.parse(typeof init?.body === 'string' ? init.body : '') as (typeof statements)[number]);
    const body = status === 200 ? { resultSetMetaData: { rowType: [] }, data: [] } : { code: '002003', message: 'does not exist' };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  }) satisfies typeof fetch;
  return { statements, fetchFn };
}

describe('EnrichmentHistory', () => {
  it('inserts the response only when its content differs from the last snapshot', async () => {
    const { statements, fetchFn } = fakeSnowflake();

    await new EnrichmentHistory(CONFIG, fetchFn).record(response(), 'test');

    expect(statements[0].statement).toBe(
      'INSERT INTO DB.CACHE.ENRICHMENT_HISTORY (ENTITY_ID, ENTITY_TYPE, CONTENT_HASH, RESPONSE, CREATED_AT) ' +
        'SELECT ?, ?, ?, PARSE_JSON(?), SYSDATE() ' +
        'FROM (SELECT MAX_BY(CONTENT_HASH, CREATED_AT) AS LAST_HASH FROM DB.CACHE.ENRICHMENT_HISTORY WHERE ENTITY_ID = ?) ' +
        'WHERE LAST_HASH IS DISTINCT FROM ?',
    );
    const values = Object.values(statements[0].bindings).map((binding) => binding.value);
    expect(values[0]).toBe('ent_1');
    expect(values[4]).toBe('ent_1');
    expect(values[5]).toBe(values[2]);
    expect(JSON.parse(values[3])).toEqual(response());
  });

  it('hashes the content without the request metadata', async () => {
    const { statements, fetchFn } = fakeSnowflake();
    const history = new EnrichmentHistory(CONFIG, fetchFn);

    await history.record(response(), 'test');
    await history.record(response({ retrievedAt: '2026-02-01T00:00:00.000Z', completeness: 'partial' }), 'test');
    await history.record(response({ name: { value: 'Example Inc', confidence: 'high', sources: [] } }), 'test');

    const hashes = statements.map((sent) => sent.bindings['3'].value);
    expect(hashes[1]).toBe(hashes[0]);
    expect(hashes[2]).not.toBe(hashes[0]);
  });

  it('skips responses where a provider failed, and is off without a table', async () => {
    const { statements, fetchFn } = fakeSnowflake();
    const failed = response({ providers: [{ provider: 'zoominfo', status: 'failed', error: 'timeout', retrievedAt: null }] });

    await new EnrichmentHistory(CONFIG, fetchFn).record(failed, 'test');
    await new EnrichmentHistory({ ...CONFIG, table: null }, fetchFn).record(response(), 'test');

    expect(statements).toHaveLength(0);
  });

  it('does not throw when the insert fails', async () => {
    const { fetchFn } = fakeSnowflake(422);

    await expect(new EnrichmentHistory(CONFIG, fetchFn).record(response(), 'test')).resolves.toBeUndefined();
  });
});

describe('loadHistoryConfig', () => {
  it('needs a qualified table name and a connection', () => {
    expect(loadHistoryConfig({}).table).toBeNull();
    expect(() => loadHistoryConfig({ ENRICHMENT_HISTORY_TABLE: 'HISTORY' })).toThrow(/fully qualified/);
    expect(() => loadHistoryConfig({ ENRICHMENT_HISTORY_TABLE: 'DB.CACHE.HISTORY' })).toThrow(/Snowflake connection/);
  });
});
