import { describe, expect, it } from 'vitest';
import type { DnbClient } from '../../dnb/dnb.client.js';
import { DnbError } from '../../dnb/dnb.errors.js';
import type { DnbMatchCriteria, DnbMatchResult, DnbOrganization } from '../../dnb/dnb.types.js';
import { DnbEnrichmentProvider } from './dnb.provider.js';
import { ProviderError } from './provider.js';

const ORGANIZATION: DnbOrganization = {
  duns: '081466849',
  name: 'Microsoft Corporation',
  website: 'www.microsoft.com',
  phone: '+1 4258828080',
  address: { street: '1 Microsoft Way', city: 'Redmond', region: 'Washington', postalCode: '98052', countryCode: 'US' },
  industry: 'Software',
  headcount: { value: 228000, reliability: 'Actual' },
  revenueUsd: { value: 245122000000, reliability: 'Modelled' },
};

function found(confidenceCode: number, candidateCount = 1): DnbMatchResult {
  return { candidate: { duns: ORGANIZATION.duns, name: ORGANIZATION.name, confidenceCode }, candidateCount, organization: ORGANIZATION };
}

function provider(answer: (criteria: DnbMatchCriteria) => Promise<DnbMatchResult>) {
  const criteria: DnbMatchCriteria[] = [];
  const dnb = {
    isAvailable: () => true,
    matchEnrich: (c: DnbMatchCriteria) => {
      criteria.push(c);
      return answer(c);
    },
  } as unknown as DnbClient;
  return { provider: new DnbEnrichmentProvider(dnb), criteria };
}

const options = { deadline: Date.now() + 5000, signal: new AbortController().signal, correlationId: 'test' };

describe('DnbEnrichmentProvider', () => {
  it('needs a company with a website or a country', () => {
    const { provider: dnb } = provider(() => Promise.resolve(found(10)));

    expect(dnb.canIdentify({ entityType: 'company', name: 'Microsoft', website: 'microsoft.com' })).toBe(true);
    expect(dnb.canIdentify({ entityType: 'company', name: 'Microsoft', address: 'Redmond, WA, United States' })).toBe(true);
    expect(dnb.canIdentify({ entityType: 'company', name: 'Microsoft', address: 'Redmond, WA 98052, USA' })).toBe(true);
    expect(dnb.canIdentify({ entityType: 'company', name: 'Microsoft', address: 'Palo Alto, CA' })).toBe(false);
    expect(dnb.canIdentify({ entityType: 'company', name: 'Microsoft' })).toBe(false);
    expect(dnb.canIdentify({ entityType: 'person', name: 'Jane Doe', website: 'microsoft.com' })).toBe(false);
  });

  it('sends the name, the website domain and the country', async () => {
    const { provider: dnb, criteria } = provider(() => Promise.resolve(found(10)));

    await dnb.identify({ entityType: 'company', name: 'Contoso Group', website: 'https://www.contoso.com/en', address: 'Amsterdam, Netherlands' }, options);

    expect(criteria).toEqual([{ name: 'Contoso Group', url: 'contoso.com', country: 'NL' }]);
  });

  it.each([
    [10, 'very_high'],
    [8, 'high'],
    [6, 'medium'],
    [3, 'low'],
  ])('matches its single candidate with confidence code %i as %s', async (code, matchConfidence) => {
    const { provider: dnb } = provider(() => Promise.resolve(found(code)));

    const result = await dnb.identify({ entityType: 'company', name: 'Microsoft', address: 'Redmond, WA, USA' }, options);

    expect(result).toMatchObject({ status: 'matched', matchConfidence });
    const candidate = { dunsNumber: '081466849', name: 'Microsoft Corporation', website: 'https://www.microsoft.com', location: 'Redmond, Washington, United States' };
    expect(result.match).toEqual(candidate);
  });

  it('is ambiguous when D&B found several candidates', async () => {
    const { provider: dnb } = provider(() => Promise.resolve(found(10, 2)));

    const result = await dnb.identify({ entityType: 'company', name: 'Microsoft', address: 'Redmond, WA, USA' }, options);

    expect(result).toMatchObject({ status: 'ambiguous', match: null, candidates: [{ dunsNumber: '081466849' }] });
  });

  it('raises the confidence of a candidate with the requested website', async () => {
    const { provider: dnb } = provider(() => Promise.resolve(found(6)));

    const result = await dnb.identify({ entityType: 'company', name: 'Microsoft', website: 'https://microsoft.com/' }, options);

    expect(result).toMatchObject({ status: 'matched', matchConfidence: 'high', match: { dunsNumber: '081466849' } });
  });

  it('enriches by DUNS number', async () => {
    const { provider: dnb, criteria } = provider(() => Promise.resolve(found(10)));

    const result = await dnb.enrich({ entityType: 'company', zoomInfoId: null, dunsNumber: '081466849' }, options);

    expect(criteria).toEqual([{ duns: '081466849' }]);
    const source = { sourceType: 'dnb', sourceReference: '081466849' };
    expect(result.observations).toEqual([
      { attribute: 'dunsNumber', value: '081466849', confidence: 'very_high', source },
      { attribute: 'name', value: 'Microsoft Corporation', confidence: 'high', source },
      { attribute: 'website', value: 'https://www.microsoft.com', confidence: 'high', source },
      { attribute: 'phone', value: '+1 4258828080', confidence: 'high', source },
      {
        attribute: 'address',
        value: { street: '1 Microsoft Way', city: 'Redmond', state: 'Washington', postalCode: '98052', country: 'United States' },
        confidence: 'high',
        source,
      },
      { attribute: 'industry', value: 'Software', confidence: 'high', source },
      { attribute: 'headcount', value: 228000, confidence: 'high', source },
      { attribute: 'annualRevenueUsd', value: 245122000000, confidence: 'medium', source },
    ]);
  });

  it('reports an unknown DUNS number as not matched', async () => {
    const { provider: dnb } = provider(() => Promise.resolve({ candidate: null, candidateCount: 0, organization: null }));

    const result = await dnb.enrich({ entityType: 'company', zoomInfoId: null, dunsNumber: '000000000' }, options);

    expect(result).toEqual({ matched: false, complete: true, observations: [], warnings: [] });
  });

  it('translates D&B errors', async () => {
    const { provider: dnb } = provider(() => Promise.reject(new DnbError('rate_limited', { retryAfterMs: 1000 })));

    const error = await dnb.enrich({ entityType: 'company', zoomInfoId: null, dunsNumber: '081466849' }, options).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 1000 });
  });
});
