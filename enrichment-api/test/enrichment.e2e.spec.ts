import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { InMemoryCacheStore } from '../src/enrichment/cache/in-memory-cache-store.js';
import { CACHE_STORE } from '../src/enrichment/cache/source-cache.js';
import { ListConsolidator } from '../src/enrichment/consolidation/list-consolidator.js';
import type { Consolidator } from '../src/enrichment/enrichment.service.js';
import { ENTITY_TABLE } from '../src/enrichment/entities/entity-table.js';
import { InMemoryEntityTable } from '../src/enrichment/entities/in-memory-entity-table.js';
import { EnrichmentHistory } from '../src/enrichment/history/enrichment-history.js';
import {
  ENRICHMENT_PROVIDERS,
  RESEARCH_PROVIDERS,
  type EnrichmentProvider,
  type ResearchProvider,
} from '../src/enrichment/providers/provider.js';

const SOURCE = { sourceType: 'zoominfo', sourceReference: '100' } as const;
const WEB_SOURCE = { sourceType: 'web_search', sourceReference: 'https://example.com/about' } as const;

const fakeZoomInfo: EnrichmentProvider = {
  name: 'zoominfo',
  isAvailable: () => true,
  canIdentify: () => true,
  canEnrich: (ref) => ref.zoomInfoId !== null,
  identify: () =>
    Promise.resolve({
      status: 'matched',
      match: { zoomInfoId: '100', name: 'Example Corp', website: 'https://example.com' },
      matchConfidence: 'high',
      candidates: [],
    }),
  enrich: (ref) =>
    Promise.resolve({
      matched: ref.zoomInfoId === '100',
      complete: true,
      observations: [
        { attribute: 'name', value: 'Example Corp', confidence: 'high', source: SOURCE },
        { attribute: 'zoomInfoId', value: '100', confidence: 'very_high', source: SOURCE },
        { attribute: 'technologies', value: 'Snowflake', confidence: 'medium', source: SOURCE },
      ],
      warnings: [],
    }),
};

const fakeWebSearch: ResearchProvider = {
  name: 'web_search',
  isAvailable: () => true,
  canResearch: () => true,
  research: () =>
    Promise.resolve({
      matched: true,
      complete: true,
      observations: [{ attribute: 'foundedYear', value: 1999, confidence: 'high', source: WEB_SOURCE }],
      warnings: [],
    }),
};

const noConsolidation: Consolidator = { isAvailable: () => false, consolidate: (_entityType, reconciled) => Promise.resolve(reconciled) };

const API_KEY = 'test-api-key';

describe('enrichment endpoints (e2e)', () => {
  let app: INestApplication<Server>;
  const post = (path: string) => request(app.getHttpServer()).post(path).set('X-API-Key', API_KEY);

  beforeAll(async () => {
    process.env.API_KEY = API_KEY;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ENRICHMENT_PROVIDERS)
      .useValue([fakeZoomInfo])
      .overrideProvider(RESEARCH_PROVIDERS)
      .useValue([fakeWebSearch])
      .overrideProvider(ListConsolidator)
      .useValue(noConsolidation)
      .overrideProvider(ENTITY_TABLE)
      .useValue(new InMemoryEntityTable())
      .overrideProvider(CACHE_STORE)
      .useValue(new InMemoryCacheStore())
      .overrideProvider(EnrichmentHistory)
      .useValue(new EnrichmentHistory({ table: null, warehouse: null, accountUrl: null, auth: null }, fetch))
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.API_KEY;
  });

  it.each([undefined, 'wrong-key'])('rejects requests with API key %s', async (key) => {
    const req = request(app.getHttpServer()).post('/v1/identify');
    if (key) req.set('X-API-Key', key);
    const res = await req.send({ entityType: 'company', name: 'Example Corp' }).expect(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  it('identifies an entity and enriches it by entityId', async () => {
    const identified = await post('/v1/identify')
      .set('X-Correlation-Id', 'sf-req-42')
      .send({ entityType: 'company', name: 'Example Corp', website: 'example.com', address: null })
      .expect(200)
      .expect('X-Correlation-Id', 'sf-req-42');
    const identifyBody = identified.body as { entityId: string };
    expect(identifyBody).toMatchObject({
      entityType: 'company',
      name: 'Example Corp',
      zoomInfoId: '100',
      dunsNumber: null,
      website: 'https://example.com',
      status: 'matched',
      matchConfidence: 'high',
      candidates: [],
      providers: [{ provider: 'zoominfo', status: 'ok', error: null }],
    });
    expect(identifyBody.entityId).toMatch(/^ent_[0-9a-f-]{36}$/);

    const enriched = await post('/v1/enrich')
      .set('X-Correlation-Id', 'not a valid id!')
      .send({ entityId: identifyBody.entityId })
      .expect(200);
    expect(enriched.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(enriched.body).toMatchObject({
      entityType: 'company',
      entityId: identifyBody.entityId,
      name: { value: 'Example Corp', confidence: 'high', sources: [SOURCE] },
      zoomInfoId: { value: '100', confidence: 'very_high', sources: [SOURCE] },
      dunsNumber: null,
      headcount: null,
      foundedYear: { value: 1999, confidence: 'high', sources: [WEB_SOURCE] },
      technologies: [{ value: 'Snowflake', confidence: 'medium', sources: [SOURCE] }],
      newsHeadlines: [],
      keyPeople: [],
      completeness: 'complete',
      warnings: [],
      providers: [
        { provider: 'zoominfo', status: 'ok', error: null },
        { provider: 'web_search', status: 'ok', error: null },
      ],
    });

    const byZoomInfoId = await post('/v1/enrich').send({ zoomInfoId: '100' }).expect(200);
    expect(byZoomInfoId.body).toMatchObject({ entityId: identifyBody.entityId });
  });

  it('returns 404 for an entityId that was never issued', async () => {
    const res = await post('/v1/enrich')
      .send({ entityId: 'ent_00000000-0000-4000-8000-000000000000' })
      .expect(404);
    expect(res.body).toMatchObject({ error: 'not_found', providers: [] });
  });

  it('returns 404 when the entity is unknown', async () => {
    const res = await post('/v1/enrich').send({ zoomInfoId: '999' }).expect(404);
    expect(res.body).toMatchObject({ error: 'not_found', providers: [{ provider: 'zoominfo', status: 'no_match' }] });
  });

  it('enriches by ZoomInfo ID and DUNS number together', async () => {
    const res = await post('/v1/enrich').send({ zoomInfoId: '100', dunsNumber: '123456789' }).expect(200);
    expect(res.body).toMatchObject({
      entityType: 'company',
      zoomInfoId: { value: '100' },
      providers: expect.arrayContaining([
        expect.objectContaining({ provider: 'zoominfo', status: 'ok' }),
        expect.objectContaining({ provider: 'dnb', status: 'unavailable', error: 'not_integrated' }),
      ]) as unknown,
    });
  });

  it.each([
    ['/v1/identify', { name: 'Example Corp' }],
    ['/v1/identify', { entityType: 'company', name: '   ' }],
    ['/v1/identify', { entityType: 'company', name: 'Example Corp', company: 'Parent Inc' }],
    ['/v1/identify', { entityType: 'company', name: 'Example Corp', website: 'javascript:alert(1)' }],
    ['/v1/identify', { entityType: 'company', name: 'Example Corp', industry: 'Software' }],
    ['/v1/enrich', {}],
    ['/v1/enrich', { entityId: 'ent_forged', zoomInfoId: '100' }],
    ['/v1/enrich', { entityId: 'ent_forged' }],
    ['/v1/enrich', { dunsNumber: '123456789', entityType: 'person' }],
    ['/v1/enrich', { zoomInfoId: '100', refresh: 'yes' }],
  ])('rejects an invalid %s body %j', async (path, body) => {
    const res = await post(path).send(body).expect(400);
    expect(res.body).toMatchObject({ error: 'invalid_request', details: [expect.any(String)] });
  });
});
