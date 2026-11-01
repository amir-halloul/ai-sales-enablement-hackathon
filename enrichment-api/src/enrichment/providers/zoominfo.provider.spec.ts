import { describe, expect, it, vi } from 'vitest';
import { ZoomInfoError } from '../../zoominfo/zoominfo.errors.js';
import type { ZoomInfoService } from '../../zoominfo/zoominfo.service.js';
import type {
  CompanyEnrichResult,
  CompanyIdentifyResult,
  CompanyProfile,
  PersonProfile,
} from '../../zoominfo/zoominfo.types.js';
import type { Observation, ProviderCallOptions } from './provider.js';
import { ProviderError } from './provider.js';
import { ZoomInfoEnrichmentProvider } from './zoominfo.provider.js';

const OPTIONS: ProviderCallOptions = { deadline: Date.now() + 10_000, signal: new AbortController().signal, correlationId: 'test' };
const ZI = { sourceType: 'zoominfo', sourceReference: '100' };

function setup(overrides: Partial<Record<keyof ZoomInfoService, unknown>>) {
  const service = { isAvailable: () => true, ...overrides } as unknown as ZoomInfoService;
  return new ZoomInfoEnrichmentProvider(service);
}

function byAttribute(observations: Observation[]) {
  const result: Record<string, { value: unknown; confidence: string }[]> = {};
  for (const o of observations) (result[o.attribute] ??= []).push({ value: o.value, confidence: o.confidence });
  return result;
}

const section = <T>(items: T[], status: 'ok' | 'failed' = 'ok') => ({
  status,
  retrievedAt: null,
  error: status === 'failed' ? ('entitlement_missing' as const) : null,
  items,
});

describe('ZoomInfoEnrichmentProvider', () => {
  it('maps a company to attributed observations with unit conversion and section warnings', async () => {
    const profile = {
      zoomInfoId: '100',
      name: 'Example Corp',
      website: 'https://www.example.com',
      address: { city: 'Springfield', country: 'United States' },
      headcount: 1200,
      revenueThousandsUsd: 50_000,
      primaryIndustry: ['Software'],
      productsAndServices: ['Widgets'],
      foundedYear: '1999',
      competitors: [{ name: 'Rival Inc' }],
      socialMediaUrls: [{ type: 'LINKED_IN', url: 'https://www.linkedin.com/company/example' }],
    } as CompanyProfile;
    const result = {
      completeness: 'partial',
      warnings: [{ section: 'technologies', code: 'entitlement_missing' }],
      profile,
      technologies: section([], 'failed'),
      keyPeople: section([
        { zoomInfoId: '1', name: 'Morgan Reyes', jobTitle: 'CEO', managementLevel: [], contactAccuracyScore: 95 },
        { zoomInfoId: '2', name: 'No Title', managementLevel: [] },
      ]),
      news: section([
        { zoomInfoId: 'n1', title: 'Example Corp expands', url: 'https://news.example.net/expands', publishedAt: '2025-06-01T08:00:00Z', categories: [] },
        { zoomInfoId: 'n2', categories: [] },
      ]),
    } as unknown as CompanyEnrichResult;
    const provider = setup({ enrichCompany: vi.fn().mockResolvedValue(result) });

    const enriched = await provider.enrich({ entityType: 'company', zoomInfoId: '100', dunsNumber: null }, OPTIONS);

    expect(enriched).toMatchObject({ matched: true, complete: false, warnings: [{ code: 'entitlement_missing', attribute: 'technologies' }] });
    const news = enriched.observations.filter((o) => o.attribute === 'newsHeadlines');
    const others = enriched.observations.filter((o) => o.attribute !== 'newsHeadlines');
    expect(news.map((o) => o.source)).toEqual([{ sourceType: 'zoominfo', sourceReference: 'https://news.example.net/expands' }]);
    expect(others.every((o) => o.source.sourceType === ZI.sourceType && o.source.sourceReference === ZI.sourceReference)).toBe(true);
    expect(byAttribute(enriched.observations)).toEqual({
      name: [{ value: 'Example Corp', confidence: 'high' }],
      zoomInfoId: [{ value: '100', confidence: 'very_high' }],
      website: [{ value: 'https://www.example.com', confidence: 'high' }],
      address: [{ value: { street: null, city: 'Springfield', state: null, postalCode: null, country: 'United States' }, confidence: 'high' }],
      industry: [{ value: 'Software', confidence: 'high' }],
      headcount: [{ value: 1200, confidence: 'medium' }],
      annualRevenueUsd: [{ value: 50_000_000, confidence: 'medium' }],
      productsAndServices: [{ value: 'Widgets', confidence: 'medium' }],
      foundedYear: [{ value: 1999, confidence: 'high' }],
      competitors: [{ value: 'Rival Inc', confidence: 'medium' }],
      socialProfiles: [{ value: 'https://www.linkedin.com/company/example', confidence: 'high' }],
      newsHeadlines: [{ value: { headline: 'Example Corp expands', date: '2025-06-01' }, confidence: 'medium' }],
      keyPeople: [{ value: { name: 'Morgan Reyes', jobTitle: 'CEO' }, confidence: 'high' }],
    });
  });

  it('maps a person with accuracy-based confidence and do-not-call warnings', async () => {
    const profile = {
      zoomInfoId: '200',
      firstName: 'Avery',
      lastName: 'Quill',
      jobTitle: 'VP Sales',
      email: 'avery@example.com',
      phone: '+1 555 0100',
      doNotCall: { phone: true },
      location: {},
      jurisdiction: { withinCanada: false },
      contactAccuracyScore: 82,
      company: { zoomInfoId: '100', name: 'Example Corp', revenueUsd: 5_000_000, address: {}, primaryIndustry: [], industries: [] },
    } as unknown as PersonProfile;
    const provider = setup({ enrichPerson: vi.fn().mockResolvedValue({ warnings: [], profile }) });

    const enriched = await provider.enrich({ entityType: 'person', zoomInfoId: '200', dunsNumber: null }, OPTIONS);

    expect(enriched.warnings).toEqual([{ code: 'do_not_call', attribute: 'phone' }]);
    expect(byAttribute(enriched.observations)).toEqual({
      name: [{ value: 'Avery Quill', confidence: 'high' }],
      zoomInfoId: [{ value: '200', confidence: 'very_high' }],
      jobTitle: [{ value: 'VP Sales', confidence: 'medium' }],
      email: [{ value: 'avery@example.com', confidence: 'medium' }],
      phone: [{ value: '+1 555 0100', confidence: 'medium' }],
      withinCanada: [{ value: false, confidence: 'high' }],
      companyName: [{ value: 'Example Corp', confidence: 'high' }],
      companyZoomInfoId: [{ value: '100', confidence: 'very_high' }],
      annualRevenueUsd: [{ value: 5_000_000, confidence: 'medium' }],
    });
  });

  it.each([
    ['zoominfo_id', undefined, 'very_high'],
    ['exact_domain', 'example.com', 'high'],
    ['single_candidate', 'example.com', 'high'],
    ['single_candidate', undefined, 'medium'],
    ['exact_name', undefined, 'medium'],
  ] as const)('rates a %s match (website %s) as %s', async (matchBasis, website, expected) => {
    const result = { status: 'matched', matchBasis, match: { zoomInfoId: '100' }, candidates: [] } as unknown as CompanyIdentifyResult;
    const provider = setup({ identifyCompany: vi.fn().mockResolvedValue(result) });

    const identified = await provider.identify({ entityType: 'company', name: 'Example Corp', website }, OPTIONS);

    expect(identified.matchConfidence).toBe(expected);
  });

  it('passes the country at the end of the address', async () => {
    const identifyCompany = vi.fn().mockResolvedValue({ status: 'no_match', matchBasis: null, match: null, candidates: [] });
    const provider = setup({ identifyCompany });

    await provider.identify({ entityType: 'company', name: 'OSF', address: 'Quebec, QC, Canada' }, OPTIONS);

    expect(identifyCompany).toHaveBeenCalledWith({ name: 'OSF', website: undefined, country: 'Canada' }, OPTIONS);
  });

  it('translates ZoomInfo errors without leaking upstream details', async () => {
    const upstream = new ZoomInfoError('rate_limited', { status: 429, upstreamCode: 'X', retryAfterMs: 2000 });
    const provider = setup({ enrichCompany: vi.fn().mockRejectedValue(upstream) });

    const error = await provider.enrich({ entityType: 'company', zoomInfoId: '100', dunsNumber: null }, OPTIONS).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderError);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 2000, message: 'Provider rate_limited' });
  });
});
