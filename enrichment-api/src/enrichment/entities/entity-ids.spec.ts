import { describe, expect, it } from 'vitest';
import { SnowflakeSqlError } from '../../snowflake/snowflake-sql.client.js';
import { EnrichmentError } from '../enrichment.errors.js';
import type { IdentifyProviderOutcome, IdentifyResponse } from '../enrichment.types.js';
import { decodeEntityId, STORED_ENTITY_ID_PATTERN } from '../entity-id.js';
import type { EntityRef } from '../providers/provider.js';
import { EntityIds } from './entity-ids.js';
import { InMemoryEntityTable } from './in-memory-entity-table.js';

const ctx = () => ({ signal: new AbortController().signal, correlationId: 'test' });

const OK: IdentifyProviderOutcome[] = [
  { provider: 'zoominfo', status: 'ok', error: null, retrievedAt: null, matchConfidence: 'high' },
  { provider: 'dnb', status: 'ok', error: null, retrievedAt: null, matchConfidence: 'high' },
];

function identified(zoomInfoId: string | null, dunsNumber: string | null, providers = OK): IdentifyResponse {
  return {
    entityType: 'company',
    name: 'Example Corp',
    entityId: null,
    zoomInfoId,
    dunsNumber,
    website: null,
    status: 'matched',
    matchConfidence: 'high',
    candidates: [],
    providers,
    retrievedAt: '2026-01-01T00:00:00.000Z',
  };
}

function company(zoomInfoId: string | null, dunsNumber: string | null): EntityRef {
  return { entityType: 'company', zoomInfoId, dunsNumber };
}

describe('EntityIds', () => {
  it('creates an entity on the first match and returns it on the next ones', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);

    const first = await ids.forIdentified(identified('100', '123456789'), ctx());
    const second = await ids.forIdentified(identified('100', '123456789'), ctx());

    expect(first).toMatch(STORED_ENTITY_ID_PATTERN);
    expect(second).toBe(first);
    expect(table.rows).toHaveLength(1);
  });

  it('attaches a provider ID that the entity did not have yet', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);

    const first = await ids.forIdentified(identified('100', null), ctx());
    const second = await ids.forIdentified(identified('100', '123456789'), ctx());

    expect(second).toBe(first);
    expect(table.rows).toMatchObject([{ entityId: first, zoomInfoId: '100', dunsNumber: '123456789' }]);
  });

  it('merges two entities into the older one, which the newer one redirects to', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);
    const older = await ids.forIdentified(identified('100', null), ctx());
    const newer = await ids.forIdentified(identified(null, '123456789'), ctx());
    expect(newer).not.toBe(older);

    const merged = await ids.forIdentified(identified('100', '123456789'), ctx());

    expect(merged).toBe(older);
    expect(table.rows).toMatchObject([
      { entityId: older, zoomInfoId: '100', dunsNumber: '123456789', mergedIntoId: null },
      { entityId: newer, zoomInfoId: null, dunsNumber: null, mergedIntoId: older },
    ]);
    const target = await ids.forEnrich({ kind: 'stored', entityId: newer ?? '', entityType: undefined }, ctx());
    expect(target).toEqual({ entityId: older, ref: company('100', '123456789') });
  });

  it('creates the entity without the ID of a failed provider, and adds it later', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);
    const failed: IdentifyProviderOutcome[] = [OK[0], { ...OK[1], status: 'failed', error: 'timeout', matchConfidence: null }];

    const first = await ids.forIdentified(identified('100', null, failed), ctx());
    const second = await ids.forIdentified(identified('100', '123456789'), ctx());

    expect(first).toMatch(STORED_ENTITY_ID_PATTERN);
    expect(second).toBe(first);
    expect(table.rows).toMatchObject([{ entityId: first, zoomInfoId: '100', dunsNumber: '123456789' }]);
  });

  it('gives no entityId when the match is not definite', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);

    expect(await ids.forIdentified({ ...identified('100', null), status: 'ambiguous' }, ctx())).toBeNull();
    expect(table.rows).toEqual([]);
  });

  it('creates entities that have no DUNS number or no ZoomInfo ID', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);

    const first = await ids.forIdentified(identified('100', null), ctx());
    const second = await ids.forIdentified(identified('200', null), ctx());
    const third = await ids.forIdentified(identified(null, '123456789'), ctx());

    expect(new Set([first, second, third]).size).toBe(3);
    expect(table.rows).toHaveLength(3);
  });

  it('merges the duplicates that concurrent requests created', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);
    await table.insert('ent_00000000-0000-4000-8000-000000000001', company('100', null));
    await table.insert('ent_00000000-0000-4000-8000-000000000002', company('100', null));

    const entityId = await ids.forIdentified(identified('100', null), ctx());

    expect(entityId).toBe('ent_00000000-0000-4000-8000-000000000001');
    expect(table.rows[1]).toMatchObject({ zoomInfoId: null, mergedIntoId: entityId });
  });

  it('fails with 503 when the entity table fails', async () => {
    const table = new InMemoryEntityTable();
    table.findByProviderIds = () => Promise.reject(new SnowflakeSqlError(403, '003001', 'Insufficient privileges'));

    const error = await new EntityIds(table).forIdentified(identified('100', null), ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnrichmentError);
    expect(error).toMatchObject({ code: 'entity_store_unavailable', providers: OK });
    expect((error as EnrichmentError).getStatus()).toBe(503);
  });

  it('encodes the provider IDs when there is no entity table', async () => {
    const table = new InMemoryEntityTable();
    table.available = false;
    const ids = new EntityIds(table);

    const entityId = await ids.forIdentified(identified('100', '123456789'), ctx());
    const target = await ids.forEnrich({ kind: 'ids', ref: company('100', null) }, ctx());

    expect(decodeEntityId(entityId ?? '')).toEqual(company('100', '123456789'));
    expect(decodeEntityId(target.entityId ?? '')).toEqual(company('100', null));
    const stored = ids.forEnrich({ kind: 'stored', entityId: 'ent_00000000-0000-4000-8000-000000000000', entityType: undefined }, ctx());
    await expect(stored).rejects.toMatchObject({ code: 'entity_store_unavailable' });
  });

  it('fills the provider IDs of an enrichment from the entity', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);
    const entityId = await ids.forIdentified(identified('100', '123456789'), ctx());

    const known = await ids.forEnrich({ kind: 'ids', ref: company('100', null) }, ctx());
    const unknown = await ids.forEnrich({ kind: 'ids', ref: company('200', null) }, ctx());

    expect(known).toEqual({ entityId, ref: company('100', '123456789') });
    expect(unknown).toEqual({ entityId: null, ref: company('200', null) });
  });

  it('rejects an unknown entityId and an entityType that does not match', async () => {
    const table = new InMemoryEntityTable();
    const ids = new EntityIds(table);
    const entityId = (await ids.forIdentified(identified('100', null), ctx())) ?? '';

    const unknown = ids.forEnrich({ kind: 'stored', entityId: 'ent_00000000-0000-4000-8000-000000000000', entityType: undefined }, ctx());
    const mismatch = ids.forEnrich({ kind: 'stored', entityId, entityType: 'person' }, ctx());

    await expect(unknown).rejects.toMatchObject({ code: 'not_found' });
    await expect(mismatch).rejects.toMatchObject({ response: { error: 'invalid_request' } });
  });
});
