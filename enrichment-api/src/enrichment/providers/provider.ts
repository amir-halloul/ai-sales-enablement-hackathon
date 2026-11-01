import type { CacheScope } from '../cache/source-cache.js';
import type { Address, Confidence, EntityType, IdentifyRequest, ProviderName, Source } from '../enrichment.types.js';

export const ENRICHMENT_PROVIDERS = Symbol('ENRICHMENT_PROVIDERS');
export const RESEARCH_PROVIDERS = Symbol('RESEARCH_PROVIDERS');

/** Provider identifiers of one entity; at least one is set. */
export interface EntityRef {
  entityType: EntityType;
  zoomInfoId: string | null;
  dunsNumber: string | null;
}

export interface ProviderCallOptions {
  /** Absolute deadline (epoch ms) of the API request. */
  deadline: number;
  signal: AbortSignal;
  correlationId: string;
  /** Absent when nothing is cached, e.g. in unit tests. */
  cache?: CacheScope;
}

export interface ScalarValues {
  name: string;
  zoomInfoId: string;
  dunsNumber: string;
  website: string;
  headcount: number;
  annualRevenueUsd: number;
  address: Address;
  phone: string;
  description: string;
  industry: string;
  ownershipType: string;
  tickerSymbol: string;
  locationCount: number;
  foundedYear: number;
  jobTitle: string;
  email: string;
  mobilePhone: string;
  companyName: string;
  companyZoomInfoId: string;
  withinCanada: boolean;
}

export interface ListValues {
  technologies: string;
  productsAndServices: string;
  competitors: string;
  socialProfiles: string;
  growthSignals: string;
  openPositions: string;
  careerHistory: string;
}

export interface NewsValue {
  headline: string;
  /** YYYY-MM-DD */
  date: string | null;
}

export interface ObservedValues extends ScalarValues, ListValues {
  keyPeople: { name: string; jobTitle: string };
  newsHeadlines: NewsValue;
}

export type ScalarAttribute = keyof ScalarValues;
export type ListAttribute = keyof ListValues;

/** One provider's claim about one attribute; the reconciler merges claims across providers. */
export type Observation = {
  [K in keyof ObservedValues]: { attribute: K; value: ObservedValues[K]; confidence: Confidence; source: Source };
}[keyof ObservedValues];

export interface ProviderCandidate {
  zoomInfoId?: string;
  dunsNumber?: string;
  name?: string;
  website?: string;
  location?: string;
  company?: string;
  jobTitle?: string;
}

export interface ProviderIdentifyResult {
  status: 'matched' | 'ambiguous' | 'no_match';
  match: ProviderCandidate | null;
  matchConfidence: Confidence | null;
  candidates: ProviderCandidate[];
}

export interface ProviderEnrichResult {
  matched: boolean;
  /** false when optional sections failed and only part of the data was retrieved. */
  complete: boolean;
  observations: Observation[];
  warnings: { code: string; attribute: string | null }[];
  /** When the result (or its oldest part) was fetched, if it came from the cache. */
  retrievedAt?: string;
}

export interface EnrichmentProvider {
  readonly name: ProviderName;
  isAvailable(): boolean;
  /** false when the request lacks what the provider needs, e.g. D&B needs a website or a country. */
  canIdentify(request: IdentifyRequest): boolean;
  identify(request: IdentifyRequest, options: ProviderCallOptions): Promise<ProviderIdentifyResult>;
  canEnrich(ref: EntityRef): boolean;
  enrich(ref: EntityRef, options: ProviderCallOptions): Promise<ProviderEnrichResult>;
}

/** An entity found by the lookup providers, as input for the research providers. */
export interface ResearchSubject {
  entityType: EntityType;
  /** Observations of the lookup providers, in precedence order. */
  observations: Observation[];
}

/**
 * A provider that needs to know what the entity is before it can run (e.g. web search needs the company name),
 * so it runs after the lookup providers and builds on their results.
 */
export interface ResearchProvider {
  readonly name: ProviderName;
  isAvailable(): boolean;
  canResearch(subject: ResearchSubject): boolean;
  research(subject: ResearchSubject, options: ProviderCallOptions): Promise<ProviderEnrichResult>;
}

export type ProviderErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'invalid_request'
  | 'auth_failed'
  | 'blocked'
  | 'entitlement_missing'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response'
  | 'internal_error';

/** Sanitized provider failure; never carries vendor payloads or credentials. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';

  constructor(
    readonly code: ProviderErrorCode,
    readonly retryAfterMs?: number,
  ) {
    super(`Provider ${code}`);
  }
}
