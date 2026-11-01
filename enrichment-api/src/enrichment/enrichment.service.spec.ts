import { describe, expect, it } from 'vitest';
import { loadCacheConfig } from './cache/cache.config.js';
import { InMemoryCacheStore } from './cache/in-memory-cache-store.js';
import { SourceCache } from './cache/source-cache.js';
import { EnrichmentError } from './enrichment.errors.js';
import { EnrichmentService, type Consolidator } from './enrichment.service.js';
import type { CompanyEnrichResponse, Confidence, ProviderName } from './enrichment.types.js';
import { decodeEntityId } from './entity-id.js';
import { EntityIds } from './entities/entity-ids.js';
import { InMemoryEntityTable } from './entities/in-memory-entity-table.js';
import { EnrichmentHistory } from './history/enrichment-history.js';
import {
  ProviderError,
  type EnrichmentProvider,
  type EntityRef,
  type Observation,
  type ProviderCandidate,
  type ProviderEnrichResult,
  type ProviderIdentifyResult,
  type ResearchProvider,
  type ResearchSubject,
} from './providers/provider.js';
import type { EnrichTarget } from './validation.js';

const BOTH_IDS_REF: EntityRef = { entityType: 'company', zoomInfoId: '100', dunsNumber: '123456789' };
const BOTH_IDS: EnrichTarget = { kind: 'ids', ref: BOTH_IDS_REF };

function provider(name: ProviderName, overrides: Partial<EnrichmentProvider>): EnrichmentProvider {
  return {
    name,
    isAvailable: () => true,
    canIdentify: () => true,
    canEnrich: (ref) => (name === 'zoominfo' ? ref.zoomInfoId : ref.dunsNumber) !== null,
    identify: () => Promise.reject(new Error('not expected')),
    enrich: () => Promise.reject(new Error('not expected')),
    ...overrides,
  };
}

function observations(name: ProviderName, reference: string, values: [string, unknown, Confidence][]): Observation[] {
  return values.map(([attribute, value, confidence]) => ({ attribute, value, confidence, source: { sourceType: name, sourceReference: reference } }) as Observation);
}

function enriched(obs: Observation[]): () => Promise<ProviderEnrichResult> {
  return () => Promise.resolve({ matched: true, complete: true, observations: obs, warnings: [] });
}

function researcher(overrides: Partial<ResearchProvider>): ResearchProvider {
  return {
    name: 'web_search',
    isAvailable: () => true,
    canResearch: () => true,
    research: () => Promise.reject(new Error('not expected')),
    ...overrides,
  };
}

const NO_CONSOLIDATOR: Consolidator = { isAvailable: () => false, consolidate: (_entityType, reconciled) => Promise.resolve(reconciled) };

const NO_HISTORY = new EnrichmentHistory({ table: null, warehouse: null, accountUrl: null, auth: null }, fetch);

/** Without a cache store, nothing is cached. */
function noCache(): InMemoryCacheStore {
  const store = new InMemoryCacheStore();
  store.available = false;
  return store;
}

function service(
  providers: EnrichmentProvider[],
  requestBudgetMs = 1000,
  researchers: ResearchProvider[] = [],
  consolidator = NO_CONSOLIDATOR,
  cacheStore = noCache(),
) {
  // Without an entity table, the entityIds encode the provider IDs.
  const table = new InMemoryEntityTable();
  table.available = false;
  const cache = new SourceCache(loadCacheConfig({}), cacheStore);
  return new EnrichmentService(providers, researchers, { requestBudgetMs }, consolidator, new EntityIds(table), cache, NO_HISTORY);
}

function matchedAs(match: ProviderCandidate, matchConfidence: Confidence = 'high'): ProviderIdentifyResult {
  return { status: 'matched', match, matchConfidence, candidates: [] };
}

const ctx = () => ({ signal: new AbortController().signal, correlationId: 'test' });

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

describe('EnrichmentService', () => {
  it('reconciles providers: agreement raises confidence, conflicts are flagged, lists are merged', async () => {
    const zoomInfo = provider('zoominfo', {
      enrich: enriched(
        observations('zoominfo', '100', [
          ['name', 'Example Corp', 'high'],
          ['website', 'https://www.example.com/', 'high'],
          ['headcount', 1200, 'medium'],
          ['technologies', 'Salesforce', 'medium'],
        ]),
      ),
    });
    const dnb = provider('dnb', {
      enrich: enriched(
        observations('dnb', '123456789', [
          ['name', 'EXAMPLE  CORP', 'high'],
          ['website', 'example.com', 'high'],
          ['headcount', 1500, 'high'],
          ['technologies', 'salesforce', 'medium'],
          ['technologies', 'Snowflake', 'medium'],
        ]),
      ),
    });

    const res = (await service([zoomInfo, dnb]).enrich(BOTH_IDS, ctx())) as CompanyEnrichResponse;

    const both = [
      { sourceType: 'zoominfo', sourceReference: '100' },
      { sourceType: 'dnb', sourceReference: '123456789' },
    ];
    expect(res.name).toEqual({ value: 'Example Corp', confidence: 'very_high', sources: both });
    expect(res.website).toEqual({ value: 'https://www.example.com/', confidence: 'very_high', sources: both });
    expect(res.headcount).toEqual({ value: 1500, confidence: 'high', sources: [both[1]] });
    expect(res.technologies).toEqual([
      { value: 'Salesforce', confidence: 'high', sources: both },
      { value: 'Snowflake', confidence: 'medium', sources: [both[1]] },
    ]);
    expect(res.warnings).toEqual([{ code: 'conflicting_values', provider: null, attribute: 'headcount' }]);
    expect(res).toMatchObject({ completeness: 'complete', description: null, keyPeople: [] });
    expect(decodeEntityId(res.entityId)).toEqual(BOTH_IDS_REF);
  });

  it('returns a partial result when a provider exceeds the request budget', async () => {
    const zoomInfo = provider('zoominfo', { enrich: enriched(observations('zoominfo', '100', [['name', 'Example Corp', 'high']])) });
    const dnb = provider('dnb', { enrich: () => new Promise(() => undefined) });

    const res = await service([zoomInfo, dnb], 50).enrich(BOTH_IDS, ctx());

    expect(res.completeness).toBe('partial');
    expect(res.name?.value).toBe('Example Corp');
    expect(res.providers).toMatchObject([
      { provider: 'zoominfo', status: 'ok' },
      { provider: 'dnb', status: 'failed', error: 'timeout' },
    ]);
  });

  it('fails with 429 and the longest retry hint when every provider is throttled', async () => {
    const zoomInfo = provider('zoominfo', { enrich: () => Promise.reject(new ProviderError('rate_limited', 2000)) });
    const dnb = provider('dnb', { enrich: () => Promise.reject(new ProviderError('quota_exceeded', 5000)) });

    const error = await service([zoomInfo, dnb]).enrich(BOTH_IDS, ctx()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(EnrichmentError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 5000 });
    expect((error as EnrichmentError).getStatus()).toBe(429);
  });

  it('reports D&B as unavailable instead of fabricating its data', async () => {
    const zoomInfo = provider('zoominfo', { enrich: enriched(observations('zoominfo', '100', [['name', 'Example Corp', 'high']])) });
    const svc = service([zoomInfo]);

    const res = await svc.enrich(BOTH_IDS, ctx());
    expect(res).toMatchObject({ completeness: 'partial', dunsNumber: null });
    expect(res.providers).toContainEqual({ provider: 'dnb', status: 'unavailable', error: 'not_integrated', retrievedAt: null });

    const dunsOnly: EnrichTarget = { kind: 'ids', ref: { entityType: 'company', zoomInfoId: null, dunsNumber: '123456789' } };
    const error = await svc.enrich(dunsOnly, ctx()).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'no_provider_available' });
    expect((error as EnrichmentError).getStatus()).toBe(503);
  });

  it('reuses a cached provider result until refresh is requested', async () => {
    let calls = 0;
    const zoomInfo = provider('zoominfo', {
      enrich: () => {
        calls++;
        return enriched(observations('zoominfo', '100', [['name', 'Example Corp', 'high']]))();
      },
    });
    const svc = service([zoomInfo], 1000, [], NO_CONSOLIDATOR, new InMemoryCacheStore());
    const zoomInfoOnly: EnrichTarget = { kind: 'ids', ref: { entityType: 'company', zoomInfoId: '100', dunsNumber: null } };

    const first = await svc.enrich(zoomInfoOnly, ctx());
    const second = await svc.enrich(zoomInfoOnly, ctx());
    expect(calls).toBe(1);
    expect(second.name?.value).toBe('Example Corp');
    expect(Date.parse(second.providers[0].retrievedAt ?? '')).toBeLessThanOrEqual(Date.parse(first.providers[0].retrievedAt ?? ''));

    await svc.enrich(zoomInfoOnly, ctx(), { refresh: true });
    expect(calls).toBe(2);
  });

  it('does not cache partial provider results', async () => {
    let calls = 0;
    const zoomInfo = provider('zoominfo', {
      enrich: () => {
        calls++;
        return Promise.resolve({ matched: true, complete: false, observations: observations('zoominfo', '100', [['name', 'Example Corp', 'high']]), warnings: [] });
      },
    });
    const svc = service([zoomInfo], 1000, [], NO_CONSOLIDATOR, new InMemoryCacheStore());
    const zoomInfoOnly: EnrichTarget = { kind: 'ids', ref: { entityType: 'company', zoomInfoId: '100', dunsNumber: null } };

    await svc.enrich(zoomInfoOnly, ctx());
    await svc.enrich(zoomInfoOnly, ctx());

    expect(calls).toBe(2);
  });

  it('returns candidates but no entityId for an ambiguous identification', async () => {
    const zoomInfo = provider('zoominfo', {
      identify: () =>
        Promise.resolve({
          status: 'ambiguous',
          match: null,
          matchConfidence: null,
          candidates: [
            { zoomInfoId: '100', name: 'Example Corp', location: 'Springfield, US' },
            { zoomInfoId: '101', name: 'Example Corp Holdings' },
          ],
        }),
    });

    const res = await service([zoomInfo]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res).toMatchObject({ status: 'ambiguous', entityId: null, zoomInfoId: null, matchConfidence: null });
    expect(res.candidates.map((c) => decodeEntityId(c.entityId)?.zoomInfoId)).toEqual(['100', '101']);
    expect(res.candidates[0]).toMatchObject({ location: 'Springfield, US', sources: [{ sourceType: 'zoominfo', sourceReference: '100' }] });
  });

  it('adds a D&B candidate to the match when its website corroborates it', async () => {
    const zoomInfo = provider('zoominfo', { identify: () => Promise.resolve(matchedAs({ zoomInfoId: '100', website: 'https://example.com' })) });
    const dnb = provider('dnb', {
      identify: () =>
        Promise.resolve({ status: 'ambiguous', match: null, matchConfidence: null, candidates: [{ dunsNumber: '123456789', website: 'https://www.example.com' }] }),
    });

    const res = await service([zoomInfo, dnb]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res).toMatchObject({ status: 'matched', zoomInfoId: '100', dunsNumber: '123456789', matchConfidence: 'high', candidates: [] });
    expect(decodeEntityId(res.entityId ?? '')).toEqual(BOTH_IDS_REF);
  });

  it('ignores a D&B match whose website differs from the first match', async () => {
    const zoomInfo = provider('zoominfo', { identify: () => Promise.resolve(matchedAs({ zoomInfoId: '100', website: 'https://example.com' })) });
    const dnb = provider('dnb', {
      identify: () => Promise.resolve(matchedAs({ dunsNumber: '123456789', website: 'https://example.org' }, 'very_high')),
    });

    const res = await service([zoomInfo, dnb]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res).toMatchObject({ status: 'matched', zoomInfoId: '100', dunsNumber: null, matchConfidence: 'high' });
  });

  it('ignores a weak D&B match that no website corroborates', async () => {
    const zoomInfo = provider('zoominfo', { identify: () => Promise.resolve(matchedAs({ zoomInfoId: '100', website: 'https://example.com' })) });
    const dnb = provider('dnb', { identify: () => Promise.resolve(matchedAs({ dunsNumber: '123456789' }, 'medium')) });

    const res = await service([zoomInfo, dnb]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res).toMatchObject({ status: 'matched', zoomInfoId: '100', dunsNumber: null });
  });

  it('reports the match confidence of each provider', async () => {
    const zoomInfo = provider('zoominfo', {
      identify: () => Promise.resolve({ status: 'ambiguous', match: null, matchConfidence: null, candidates: [{ zoomInfoId: '100' }, { zoomInfoId: '101' }] }),
    });
    const dnb = provider('dnb', { identify: () => Promise.resolve(matchedAs({ dunsNumber: '123456789' }, 'low')) });

    const res = await service([zoomInfo, dnb]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res).toMatchObject({ status: 'matched', dunsNumber: '123456789', matchConfidence: 'low' });
    expect(res.candidates.map((c) => c.zoomInfoId)).toEqual(['100', '101']);
    expect(res.providers).toMatchObject([
      { provider: 'zoominfo', status: 'ambiguous', matchConfidence: null },
      { provider: 'dnb', status: 'ok', matchConfidence: 'low' },
    ]);
  });

  it('skips a provider that lacks the input it needs', async () => {
    const zoomInfo = provider('zoominfo', { identify: () => Promise.resolve(matchedAs({ zoomInfoId: '100' })) });
    const dnb = provider('dnb', { canIdentify: () => false });

    const res = await service([zoomInfo, dnb]).identify({ entityType: 'company', name: 'Example Corp' }, ctx());

    expect(res.status).toBe('matched');
    expect(res.providers).toContainEqual({ provider: 'dnb', status: 'unavailable', error: 'insufficient_input', retrievedAt: null, matchConfidence: null });
  });

  it('fails with 404 when no provider finds the entity', async () => {
    const zoomInfo = provider('zoominfo', {
      enrich: () => Promise.resolve({ matched: false, complete: true, observations: [], warnings: [] }),
    });

    const zoomInfoOnly: EnrichTarget = { kind: 'ids', ref: { entityType: 'company', zoomInfoId: '100', dunsNumber: null } };
    const error = await service([zoomInfo]).enrich(zoomInfoOnly, ctx()).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'not_found' });
    expect((error as EnrichmentError).getStatus()).toBe(404);
  });

  it('runs research after the lookup, with the lookup results, and corroborates estimates', async () => {
    const zoomInfo = provider('zoominfo', {
      enrich: enriched(
        observations('zoominfo', '100', [
          ['name', 'Example Corp', 'high'],
          ['headcount', 21000, 'medium'],
        ]),
      ),
    });
    let subject: ResearchSubject | undefined;
    const webSearch = researcher({
      research: (s) => {
        subject = s;
        return enriched(
          observations('web_search', 'https://example.com/about', [
            ['headcount', 21100, 'high'],
            ['socialProfiles', 'https://www.linkedin.com/company/example', 'high'],
          ]),
        )();
      },
    });

    const res = (await service([zoomInfo], 1000, [webSearch]).enrich(BOTH_IDS, ctx())) as CompanyEnrichResponse;

    expect(subject?.observations.map((o) => o.attribute)).toEqual(['name', 'headcount']);
    expect(res.headcount).toEqual({
      value: 21000,
      confidence: 'very_high',
      sources: [
        { sourceType: 'zoominfo', sourceReference: '100' },
        { sourceType: 'web_search', sourceReference: 'https://example.com/about' },
      ],
    });
    expect(res.socialProfiles).toHaveLength(1);
    expect(res.providers).toContainEqual(expect.objectContaining({ provider: 'web_search', status: 'ok' }));
    expect(res.warnings).toEqual([]);
  });

  it('settles a conflict between ZoomInfo and D&B with the value an independent source confirms', async () => {
    const zoomInfo = provider('zoominfo', {
      enrich: enriched(observations('zoominfo', '100', [['name', 'Example Corp', 'high'], ['headcount', 1200, 'medium'], ['foundedYear', 1999, 'high']])),
    });
    const dnb = provider('dnb', {
      enrich: enriched(observations('dnb', '123456789', [['headcount', 5000, 'very_high'], ['foundedYear', 2001, 'high']])),
    });
    const webSearch = researcher({
      research: enriched(observations('web_search', 'https://news.example.org/a', [['headcount', 1250, 'low']])),
    });

    const res = (await service([zoomInfo, dnb], 1000, [webSearch]).enrich(BOTH_IDS, ctx())) as CompanyEnrichResponse;

    expect(res.headcount).toEqual({
      value: 1200,
      confidence: 'medium',
      sources: [
        { sourceType: 'zoominfo', sourceReference: '100' },
        { sourceType: 'web_search', sourceReference: 'https://news.example.org/a' },
      ],
    });
    // Without independent confirmation, the usual rules apply: equal confidence, so the first provider wins.
    expect(res.foundedYear).toMatchObject({ value: 1999, sources: [{ sourceType: 'zoominfo', sourceReference: '100' }] });
    expect(res.warnings).toEqual(
      expect.arrayContaining([
        { code: 'conflicting_values', provider: null, attribute: 'headcount' },
        { code: 'conflicting_values', provider: null, attribute: 'foundedYear' },
      ]),
    );
  });

  it('returns the lookup data as a partial result when research fails', async () => {
    const zoomInfo = provider('zoominfo', { enrich: enriched(observations('zoominfo', '100', [['name', 'Example Corp', 'high']])) });
    const webSearch = researcher({ research: () => Promise.reject(new ProviderError('timeout')) });

    const res = await service([zoomInfo], 1000, [webSearch]).enrich(BOTH_IDS, ctx());

    expect(res).toMatchObject({ completeness: 'partial', name: { value: 'Example Corp' } });
    expect(res.providers).toContainEqual({ provider: 'web_search', status: 'failed', error: 'timeout', retrievedAt: null });
  });

  it('merges news across sources with their date, newest first, and drops old news', async () => {
    const zoomInfo = provider('zoominfo', {
      enrich: enriched(
        observations('zoominfo', '100', [
          ['newsHeadlines', { headline: 'Example Corp acquires Widget, Inc.', date: daysAgo(60) }, 'medium'],
          ['newsHeadlines', { headline: 'Example Corp opened its first office', date: daysAgo(1000) }, 'medium'],
          ['newsHeadlines', { headline: 'Example Corp names a new CFO', date: null }, 'medium'],
        ]),
      ),
    });
    const webSearch = researcher({
      research: enriched(
        observations('web_search', 'https://news.example.net/a', [
          ['newsHeadlines', { headline: 'Example Corp Acquires Widget Inc', date: daysAgo(61) }, 'high'],
          ['newsHeadlines', { headline: 'Example Corp reports record results', date: daysAgo(10) }, 'medium'],
        ]),
      ),
    });

    const res = (await service([zoomInfo], 1000, [webSearch]).enrich(BOTH_IDS, ctx())) as CompanyEnrichResponse;

    expect(res.newsHeadlines.map((n) => [n.value, n.date, n.confidence])).toEqual([
      ['Example Corp reports record results', daysAgo(10), 'medium'],
      ['Example Corp acquires Widget, Inc.', daysAgo(61), 'very_high'],
      ['Example Corp names a new CFO', null, 'medium'],
    ]);
  });

  it('consolidates the reconciled lists, keeping time for it after the research', async () => {
    let researchDeadline = 0;
    const zoomInfo = provider('zoominfo', {
      enrich: enriched(
        observations('zoominfo', '100', [
          ['name', 'Example Corp', 'high'],
          ['productsAndServices', 'Services', 'medium'],
          ['productsAndServices', 'Payroll', 'medium'],
        ]),
      ),
    });
    const webSearch = researcher({
      research: (_subject, options) => {
        researchDeadline = options.deadline;
        return enriched([])();
      },
    });
    let consolidated: string[] = [];
    const consolidator: Consolidator = {
      isAvailable: () => true,
      consolidate: (_entityType, reconciled) => {
        consolidated = reconciled.lists.productsAndServices.map((p) => p.value);
        const payroll = { value: 'Payroll software', confidence: 'medium' as const, sources: [] };
        return Promise.resolve({ ...reconciled, lists: { ...reconciled.lists, productsAndServices: [payroll] } });
      },
    };

    const started = Date.now();
    const res = (await service([zoomInfo], 60_000, [webSearch], consolidator).enrich(BOTH_IDS, ctx())) as CompanyEnrichResponse;
    const finished = Date.now();

    expect(researchDeadline).toBeGreaterThanOrEqual(started + 40_000);
    expect(researchDeadline).toBeLessThanOrEqual(finished + 40_000);
    expect(consolidated).toEqual(['Payroll']);
    expect(res.productsAndServices.map((p) => p.value)).toEqual(['Payroll software']);
  });
});
