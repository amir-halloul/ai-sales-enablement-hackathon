import { Inject, Injectable } from '@nestjs/common';
import { countryCodeOf, countryName } from '../../common/country.js';
import { sameRegistrableDomain } from '../../common/registrable-domain.js';
import { DnbClient } from '../../dnb/dnb.client.js';
import { DnbError } from '../../dnb/dnb.errors.js';
import type { DnbAddress, DnbFigure, DnbMatchCriteria, DnbMatchResult, DnbOrganization } from '../../dnb/dnb.types.js';
import { raiseConfidence } from '../confidence.js';
import type { Address, Confidence, IdentifyRequest, Source } from '../enrichment.types.js';
import { normalizeWebsite } from '../reconcile.js';
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

/** D&B confidence codes (1 to 10): 8 and above is a reliable match; 5 to 7 is plausible; below 5 is weak. */
const MATCHED_CODE = 8;
const PLAUSIBLE_CODE = 5;
const EXACT_CODE = 10;

const NO_MATCH: ProviderIdentifyResult = { status: 'no_match', match: null, matchConfidence: null, candidates: [] };
const NOT_MATCHED: ProviderEnrichResult = { matched: false, complete: true, observations: [], warnings: [] };

/** Companies only: D&B is a company register. */
@Injectable()
export class DnbEnrichmentProvider implements EnrichmentProvider {
  readonly name = 'dnb';

  constructor(@Inject(DnbClient) private readonly dnb: DnbClient) {}

  isAvailable(): boolean {
    return this.dnb.isAvailable();
  }

  canIdentify(request: IdentifyRequest): boolean {
    return identifyCriteria(request) !== null;
  }

  canEnrich(ref: EntityRef): boolean {
    return ref.entityType === 'company' && ref.dunsNumber !== null;
  }

  async identify(request: IdentifyRequest, options: ProviderCallOptions): Promise<ProviderIdentifyResult> {
    const criteria = identifyCriteria(request);
    if (!criteria) throw new ProviderError('invalid_request');
    try {
      return identifyResult(await this.dnb.matchEnrich(criteria, options), criteria.url);
    } catch (error) {
      throw toProviderError(error);
    }
  }

  async enrich(ref: EntityRef, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
    const duns = ref.dunsNumber;
    if (duns === null || ref.entityType !== 'company') throw new ProviderError('invalid_request');
    try {
      const result = await this.dnb.matchEnrich({ duns }, options);
      // A DUNS lookup normally returns the same DUNS with code 10, or its replacement after a merger.
      const found = (result.candidate?.confidenceCode ?? 0) >= MATCHED_CODE;
      return found && result.organization ? enrichResult(result.organization) : NOT_MATCHED;
    } catch (error) {
      throw toProviderError(error);
    }
  }
}

/** D&B needs a website, or a name with a country; the country is read from the end of the address. */
function identifyCriteria(request: IdentifyRequest): DnbMatchCriteria | null {
  if (request.entityType !== 'company') return null;
  const url = request.website ? normalizeWebsite(request.website) : undefined;
  const country = countryCodeOf(request.address);
  if (!url && !country) return null;
  return { name: request.name, url, country };
}

/** A lone candidate is the match, however weak; the confidence says how weak. */
function identifyResult(result: DnbMatchResult, requestedDomain: string | undefined): ProviderIdentifyResult {
  if (!result.candidate) return NO_MATCH;
  const candidate = toCandidate(result);
  if (result.candidateCount > 1) return { status: 'ambiguous', match: null, matchConfidence: null, candidates: [candidate] };
  const matchConfidence = codeConfidence(result.candidate.confidenceCode);
  // D&B scores name and address only, so a matching website adds to its confidence.
  const sameWebsite = sameRegistrableDomain(candidate.website, requestedDomain);
  const confidence = sameWebsite ? raiseConfidence(matchConfidence) : matchConfidence;
  return { status: 'matched', match: candidate, matchConfidence: confidence, candidates: [] };
}

function codeConfidence(code: number): Confidence {
  if (code >= EXACT_CODE) return 'very_high';
  if (code >= MATCHED_CODE) return 'high';
  if (code >= PLAUSIBLE_CODE) return 'medium';
  return 'low';
}

function toCandidate(result: DnbMatchResult): ProviderCandidate {
  const organization = result.organization;
  const address = organization?.address;
  return {
    dunsNumber: result.candidate?.duns,
    name: organization?.name ?? result.candidate?.name,
    website: organization?.website ? withScheme(organization.website) : undefined,
    location: address ? join([address.city, address.region, countryName(address.countryCode)]) : undefined,
  };
}

function enrichResult(org: DnbOrganization): ProviderEnrichResult {
  const found = new Observations({ sourceType: 'dnb', sourceReference: org.duns });

  found.add('dunsNumber', org.duns, 'very_high');
  found.add('name', org.name, 'high');
  found.add('website', org.website ? withScheme(org.website) : undefined, 'high');
  found.add('phone', org.phone, 'high');
  found.add('address', org.address ? toAddress(org.address) : undefined, 'high');
  found.add('industry', org.industry, 'high');
  found.add('headcount', org.headcount?.value, figureConfidence(org.headcount));
  found.add('annualRevenueUsd', org.revenueUsd?.value, figureConfidence(org.revenueUsd));

  return { matched: true, complete: true, observations: found.items, warnings: [] };
}

/** D&B marks each figure as actual (reported) or estimated/modelled. */
function figureConfidence(figure: DnbFigure | undefined): Confidence {
  return figure?.reliability === 'Actual' ? 'high' : 'medium';
}

function toAddress(a: DnbAddress): Address {
  return {
    street: a.street ?? null,
    city: a.city ?? null,
    state: a.region ?? null,
    postalCode: a.postalCode ?? null,
    country: countryName(a.countryCode) ?? null,
  };
}

/** D&B returns websites like "www.example.com". */
function withScheme(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

function join(parts: (string | undefined)[]): string | undefined {
  return parts.filter(Boolean).join(', ') || undefined;
}

/** Collects observations from one D&B record, skipping empty values. */
class Observations {
  readonly items: Observation[] = [];

  constructor(private readonly source: Source) {}

  add<K extends keyof ObservedValues>(attribute: K, value: ObservedValues[K] | undefined, confidence: Confidence): void {
    if (value === undefined || value === '') return;
    this.items.push({ attribute, value, confidence, source: this.source } as Observation);
  }
}

function toProviderError(error: unknown): unknown {
  return error instanceof DnbError ? new ProviderError(error.code, error.details.retryAfterMs) : error;
}
