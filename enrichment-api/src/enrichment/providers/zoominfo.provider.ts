import { Inject, Injectable } from '@nestjs/common';
import { countryCodeOf, countryName } from '../../common/country.js';
import { isoDate } from '../../common/iso-date.js';
import { ZoomInfoError } from '../../zoominfo/zoominfo.errors.js';
import { ZoomInfoService } from '../../zoominfo/zoominfo.service.js';
import type {
  CompanyCandidate,
  CompanyEnrichResult,
  IdentifyResult,
  MatchBasis,
  PersonCandidate,
  PersonEnrichResult,
  ZoomInfoWarning,
} from '../../zoominfo/zoominfo.types.js';
import type { Address, Confidence, IdentifyRequest, Source } from '../enrichment.types.js';
import { httpUrl } from './model-answer.js';
import {
  ProviderError,
  type EnrichmentProvider,
  type EntityRef,
  type Observation,
  type ObservedValues,
  type ProviderCallOptions,
  type ProviderCandidate,
  type ProviderEnrichResult,
  type ProviderIdentifyResult,
} from './provider.js';

const SECTION_ATTRIBUTE: Record<ZoomInfoWarning['section'], string | null> = {
  profile: null,
  technologies: 'technologies',
  keyPeople: 'keyPeople',
  news: 'newsHeadlines',
};

@Injectable()
export class ZoomInfoEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'zoominfo';

  constructor(@Inject(ZoomInfoService) private readonly zoomInfo: ZoomInfoService) {}

  isAvailable(): boolean {
    return this.zoomInfo.isAvailable();
  }

  canIdentify(): boolean {
    return true;
  }

  canEnrich(ref: EntityRef): boolean {
    return ref.zoomInfoId !== null;
  }

  async identify(request: IdentifyRequest, options: ProviderCallOptions): Promise<ProviderIdentifyResult> {
    const websiteGiven = request.website !== undefined;
    try {
      if (request.entityType === 'company') {
        const country = countryName(countryCodeOf(request.address));
        const result = await this.zoomInfo.identifyCompany({ name: request.name, website: request.website, country }, options);
        return identifyResult(result, websiteGiven, companyCandidate);
      }
      const result = await this.zoomInfo.identifyPerson(
        { fullName: request.name, companyName: request.company, companyWebsite: request.website },
        options,
      );
      return identifyResult(result, websiteGiven, personCandidate);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async enrich(ref: EntityRef, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
    const zoomInfoId = ref.zoomInfoId;
    if (zoomInfoId === null) throw new ProviderError('invalid_request');
    try {
      if (ref.entityType === 'company') {
        return companyResult(await this.zoomInfo.enrichCompany({ zoomInfoId }, options));
      }
      return personResult(await this.zoomInfo.enrichPerson({ zoomInfoId }, options));
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

const NOT_MATCHED: ProviderEnrichResult = { matched: false, complete: true, observations: [], warnings: [] };

function identifyResult<T extends { zoomInfoId: string }>(
  result: IdentifyResult<T>,
  websiteGiven: boolean,
  toCandidate: (candidate: T) => ProviderCandidate,
): ProviderIdentifyResult {
  return {
    status: result.status,
    match: result.match ? toCandidate(result.match) : null,
    matchConfidence: result.matchBasis ? matchConfidence(result.matchBasis, websiteGiven) : null,
    candidates: result.candidates.map(toCandidate),
  };
}

function matchConfidence(basis: MatchBasis, websiteGiven: boolean): Confidence {
  switch (basis) {
    case 'zoominfo_id':
      return 'very_high';
    case 'exact_domain':
      return 'high';
    case 'single_candidate':
      return websiteGiven ? 'high' : 'medium';
    case 'exact_name':
      return 'medium';
  }
}

function companyCandidate(c: CompanyCandidate): ProviderCandidate {
  return { zoomInfoId: c.zoomInfoId, name: c.name, website: c.website, location: join([c.city, c.state, c.country], ', ') };
}

function personCandidate(c: PersonCandidate): ProviderCandidate {
  return { zoomInfoId: c.zoomInfoId, name: join([c.firstName, c.lastName]), company: c.company?.name, jobTitle: c.jobTitle };
}

function companyResult(result: CompanyEnrichResult): ProviderEnrichResult {
  const profile = result.profile;
  if (!profile) return NOT_MATCHED;
  const found = new Observations({ sourceType: 'zoominfo', sourceReference: profile.zoomInfoId });

  found.add('name', profile.name, 'high');
  found.add('zoomInfoId', profile.zoomInfoId, 'very_high');
  found.add('website', profile.website, 'high');
  found.add('description', profile.description, 'high');
  found.add('phone', profile.phone, 'high');
  found.add('address', toAddress(profile.address), 'high');
  found.add('industry', profile.primaryIndustry[0], 'high');
  found.add('ownershipType', profile.ownershipType, 'high');
  found.add('tickerSymbol', profile.ticker, 'high');
  found.add('foundedYear', toYear(profile.foundedYear), 'high');

  // ZoomInfo estimates these figures.
  found.add('headcount', profile.headcount, 'medium');
  found.add('annualRevenueUsd', thousandsToUnits(profile.revenueThousandsUsd), 'medium');
  found.add('locationCount', profile.locationCount, 'medium');

  for (const item of profile.productsAndServices) found.add('productsAndServices', item, 'medium');
  for (const competitor of profile.competitors) found.add('competitors', competitor.name, 'medium');
  for (const social of profile.socialMediaUrls) found.add('socialProfiles', social.url, 'high');
  for (const tech of result.technologies.items) found.add('technologies', tech.product ?? tech.vendor, 'medium');
  for (const article of result.news.items) {
    if (!article.title) continue;
    const source = articleSource(article.url, profile.zoomInfoId);
    found.add('newsHeadlines', { headline: article.title, date: isoDate(article.publishedAt) ?? null }, 'medium', source);
  }
  for (const person of result.keyPeople.items) {
    if (!person.name || !person.jobTitle) continue;
    found.add('keyPeople', { name: person.name, jobTitle: person.jobTitle }, accuracyConfidence(person.contactAccuracyScore));
  }

  return {
    matched: true,
    complete: result.completeness === 'complete',
    observations: found.items,
    warnings: result.warnings.map((w) => ({ code: w.code, attribute: SECTION_ATTRIBUTE[w.section] })),
  };
}

function personResult(result: PersonEnrichResult): ProviderEnrichResult {
  const profile = result.profile;
  if (!profile) return NOT_MATCHED;
  const found = new Observations({ sourceType: 'zoominfo', sourceReference: profile.zoomInfoId });
  const contactConfidence = accuracyConfidence(profile.contactAccuracyScore);

  found.add('name', join([profile.firstName, profile.middleName, profile.lastName]), 'high');
  found.add('zoomInfoId', profile.zoomInfoId, 'very_high');
  found.add('jobTitle', profile.jobTitle, contactConfidence);
  found.add('email', profile.email, contactConfidence);
  found.add('phone', profile.phone, contactConfidence);
  found.add('mobilePhone', profile.mobilePhone, contactConfidence);
  found.add('address', toAddress(profile.location), contactConfidence);
  found.add('withinCanada', profile.jurisdiction.withinCanada, 'high');

  const company = profile.company;
  if (company) {
    found.add('companyName', company.name, 'high');
    found.add('companyZoomInfoId', company.zoomInfoId, 'very_high');
    found.add('website', company.website, 'high');
    found.add('headcount', company.headcount, 'medium');
    found.add('annualRevenueUsd', company.revenueUsd, 'medium');
  }

  const warnings: ProviderEnrichResult['warnings'] = result.warnings.map((w) => ({ code: w.code, attribute: null }));
  if (profile.phone && profile.doNotCall.phone) warnings.push({ code: 'do_not_call', attribute: 'phone' });
  if (profile.mobilePhone && profile.doNotCall.mobilePhone) warnings.push({ code: 'do_not_call', attribute: 'mobilePhone' });

  return { matched: true, complete: true, observations: found.items, warnings };
}

/** Collects observations from one ZoomInfo record, skipping empty values. */
class Observations {
  readonly items: Observation[] = [];

  constructor(private readonly source: Source) {}

  add<K extends keyof ObservedValues>(
    attribute: K,
    value: ObservedValues[K] | undefined,
    confidence: Confidence,
    source: Source = this.source,
  ): void {
    if (value === undefined || value === '') return;
    this.items.push({ attribute, value, confidence, source } as Observation);
  }
}

/** A news article is cited by its own link, like the research sources; the company ID when it has none. */
function articleSource(url: string | undefined, zoomInfoId: string): Source {
  return { sourceType: 'zoominfo', sourceReference: httpUrl(url) ?? zoomInfoId };
}

/** ZoomInfo's contact accuracy score ranges from 70 to 99. */
function accuracyConfidence(score: number | undefined): Confidence {
  if (score === undefined) return 'medium';
  if (score >= 90) return 'high';
  if (score >= 80) return 'medium';
  return 'low';
}

function thousandsToUnits(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}

function toYear(value: string | undefined): number | undefined {
  return value && /^\d{4}$/.test(value.trim()) ? Number(value) : undefined;
}

function toAddress(a: { street?: string; city?: string; state?: string; zipCode?: string; country?: string }): Address | undefined {
  if (!a.street && !a.city && !a.state && !a.zipCode && !a.country) return undefined;
  return { street: a.street ?? null, city: a.city ?? null, state: a.state ?? null, postalCode: a.zipCode ?? null, country: a.country ?? null };
}

function join(parts: (string | undefined)[], separator = ' '): string | undefined {
  return parts.filter(Boolean).join(separator) || undefined;
}

function toProviderError(error: unknown): unknown {
  return error instanceof ZoomInfoError ? new ProviderError(error.code, error.details.retryAfterMs) : error;
}
