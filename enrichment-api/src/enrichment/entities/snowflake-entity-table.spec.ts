import { describe, expect, it } from 'vitest';
import { loadEntityStoreConfig, type EntityStoreConfig } from './entity-store.config.js';
import { SnowflakeEntityTable } from './snowflake-entity-table.js';

const CONFIG: EntityStoreConfig = {
  table: 'DB.CACHE.ENTITY',
  warehouse: 'CACHE_WH',
  accountUrl: 'https://acme.snowflakecomputing.com',
  auth: { type: 'pat', token: 'secret' },
};

const ROW_TYPE = ['ENTITY_ID', 'ENTITY_TYPE', 'ZOOMINFO_ID', 'DUNS', 'MERGED_INTO_ID', 'CREATED_MS'].map((name) => ({ name }));

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: { statement: string; warehouse?: string; bindings?: Record<string, { type: string; value: string }> };
}

function fakeSnowflake(responses: { status: number; body: unknown }[]) {
  const requests: SentRequest[] = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const body = typeof init?.body === 'string' ? init.body : '';
    requests.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(body) as SentRequest['body'] });
    const next = responses.shift() ?? { status: 200, body: { resultSetMetaData: { rowType: [] }, data: [] } };
    return Promise.resolve(new Response(JSON.stringify(next.body), { status: next.status }));
  }) satisfies typeof fetch;
  return { requests, table: new SnowflakeEntityTable(CONFIG, fetchFn) };
}

const signal = () => new AbortController().signal;

describe('SnowflakeEntityTable', () => {
  it('finds entities by provider ID with bound values', async () => {
    const row = ['ent_1', 'company', '100', null, null, '1767225600000'];
    const { requests, table } = fakeSnowflake([{ status: 200, body: { resultSetMetaData: { rowType: ROW_TYPE }, data: [row] } }]);

    const entities = await table.findByProviderIds({ entityType: 'company', zoomInfoId: '100', dunsNumber: '123456789' }, signal());

    expect(entities).toEqual([
      { entityId: 'ent_1', entityType: 'company', zoomInfoId: '100', dunsNumber: null, mergedIntoId: null, createdAtMs: 1767225600000 },
    ]);
    expect(requests[0].url).toBe('https://acme.snowflakecomputing.com/api/v2/statements');
    expect(requests[0].headers['x-snowflake-authorization-token-type']).toBe('PROGRAMMATIC_ACCESS_TOKEN');
    expect(requests[0].body.statement).toMatch(/FROM DB\.CACHE\.ENTITY WHERE ENTITY_TYPE = \? AND \(ZOOMINFO_ID = \? OR DUNS = \?\)$/);
    expect(requests[0].body.warehouse).toBe('CACHE_WH');
    expect(requests[0].body.bindings).toEqual({
      '1': { type: 'TEXT', value: 'company' },
      '2': { type: 'TEXT', value: '100' },
      '3': { type: 'TEXT', value: '123456789' },
    });
  });

  it('inserts a missing provider ID as NULL and reports errors as failures', async () => {
    const { requests, table } = fakeSnowflake([
      { status: 200, body: { resultSetMetaData: { rowType: [] }, data: [] } },
      { status: 422, body: { code: '002003', message: 'Object does not exist or not authorized.' } },
    ]);
    const ref = { entityType: 'company' as const, zoomInfoId: '100', dunsNumber: null };

    await table.insert('ent_1', ref, signal());
    await expect(table.insert('ent_2', ref, signal())).rejects.toMatchObject({ status: 422, code: '002003' });
    expect(requests[0].body.statement).toContain("NULLIF(?, '')");
    expect(requests[0].body.bindings).toMatchObject({ '3': { value: '100' }, '4': { value: '' } });
  });

  it('only sets the provider IDs that the reference has', async () => {
    const { requests, table } = fakeSnowflake([]);

    await table.setProviderIds('ent_1', { entityType: 'company', zoomInfoId: null, dunsNumber: '123456789' }, signal());

    expect(requests[0].body.statement).toBe('UPDATE DB.CACHE.ENTITY SET DUNS = ? WHERE ENTITY_ID = ?');
  });
});

describe('loadEntityStoreConfig', () => {
  const connection = { SNOWFLAKE_ACCOUNT_URL: 'https://acme.snowflakecomputing.com', SNOWFLAKE_PAT: 'secret' };

  it('is off without a table', () => {
    expect(loadEntityStoreConfig({})).toMatchObject({ table: null, warehouse: null });
  });

  it('rejects names that are not plain identifiers', () => {
    expect(() => loadEntityStoreConfig({ ...connection, ENTITY_STORE_TABLE: 'DB.CACHE.ENTITY; DROP TABLE X' })).toThrow();
    expect(() => loadEntityStoreConfig({ ...connection, ENTITY_STORE_TABLE: 'ENTITY' })).toThrow();
    expect(() => loadEntityStoreConfig({ ...connection, ENTITY_STORE_TABLE: 'DB.CACHE.ENTITY', SNOWFLAKE_WAREHOUSE: 'WH"' })).toThrow();
  });

  it('needs a Snowflake connection when a table is set', () => {
    expect(() => loadEntityStoreConfig({ ENTITY_STORE_TABLE: 'DB.CACHE.ENTITY' })).toThrow();
    expect(loadEntityStoreConfig({ ...connection, ENTITY_STORE_TABLE: 'DB.CACHE.ENTITY' })).toMatchObject({ table: 'DB.CACHE.ENTITY' });
  });
});
