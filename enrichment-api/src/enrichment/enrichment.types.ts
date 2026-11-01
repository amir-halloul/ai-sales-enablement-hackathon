// Public API contract shared by Identify and Enrich (see the Snowflake specification page).

export type EntityType = 'company' | 'person';

export const CONFIDENCE_LEVELS = ['low', 'medium', 'high', 'very_high'] as const;
export type Confidence = (typeof CONFIDENCE_LEVELS)[number];

export type SourceType = 'user_provided' | 'zoominfo' | 'dnb' | 'web_search' | 'web_page';
export type ProviderName = Exclude<SourceType, 'user_provided'>;

export interface Source {
  sourceType: SourceType;
  /** null, the provider ID (zoominfo, dnb) or a link (web_search, web_page, zoominfo news). */
  sourceReference: string | null;
}

export interface AttributedValue<T> {
  value: T;
  confidence: Confidence;
  sources: Source[];
}

export interface KeyPerson {
  name: AttributedValue<string>;
  jobTitle: AttributedValue<string>;
}

/** A news headline (the value) with its publication date. */
export interface NewsHeadline extends AttributedValue<string> {
  /** YYYY-MM-DD; null when no source gave a date. */
  date: string | null;
}

export interface Address {
  street: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface ProviderOutcome {
  provider: ProviderName;
  status: 'ok' | 'partial' | 'ambiguous' | 'no_match' | 'failed' | 'unavailable';
  error: string | null;
  retrievedAt: string | null;
}

export interface IdentifyProviderOutcome extends ProviderOutcome {
  /** How sure this provider is of its own match; null unless it found one. */
  matchConfidence: Confidence | null;
}

export interface EnrichmentWarning {
  code: string;
  provider: ProviderName | null;
  attribute: string | null;
}

export interface IdentifyRequest {
  entityType: EntityType;
  name: string;
  address?: string;
  company?: string;
  website?: string;
}

export interface IdentifyCandidate {
  entityId: string;
  zoomInfoId: string | null;
  dunsNumber: string | null;
  name: string | null;
  website: string | null;
  location: string | null;
  company: string | null;
  jobTitle: string | null;
  sources: Source[];
}

export interface IdentifyResponse {
  entityType: EntityType;
  name: string;
  /** The internal ID of the entity; null unless status is matched: ambiguous matches must not drive CRM updates. */
  entityId: string | null;
  zoomInfoId: string | null;
  dunsNumber: string | null;
  website: string | null;
  status: 'matched' | 'ambiguous' | 'no_match';
  matchConfidence: Confidence | null;
  candidates: IdentifyCandidate[];
  providers: IdentifyProviderOutcome[];
  retrievedAt: string;
}

type Attributed<T> = AttributedValue<T> | null;

interface EnrichResponseBase {
  entityId: string;
  name: Attributed<string>;
  zoomInfoId: Attributed<string>;
  dunsNumber: Attributed<string>;
  website: Attributed<string>;
  headcount: Attributed<number>;
  annualRevenueUsd: Attributed<number>;
  address: Attributed<Address>;
  phone: Attributed<string>;
  completeness: 'complete' | 'partial';
  warnings: EnrichmentWarning[];
  providers: ProviderOutcome[];
  retrievedAt: string;
}

export interface CompanyEnrichResponse extends EnrichResponseBase {
  entityType: 'company';
  description: Attributed<string>;
  industry: Attributed<string>;
  ownershipType: Attributed<string>;
  tickerSymbol: Attributed<string>;
  locationCount: Attributed<number>;
  foundedYear: Attributed<number>;
  technologies: AttributedValue<string>[];
  /** Newest first; undated headlines last. */
  newsHeadlines: NewsHeadline[];
  productsAndServices: AttributedValue<string>[];
  competitors: AttributedValue<string>[];
  /** URLs of the official social media profiles. */
  socialProfiles: AttributedValue<string>[];
  /** Dated one-sentence summaries of results, funding, acquisitions, hiring and other growth signals. */
  growthSignals: AttributedValue<string>[];
  /** Roles the company is hiring for, from its careers pages, e.g. "Senior Data Engineer (Toronto)". */
  openPositions: AttributedValue<string>[];
  keyPeople: KeyPerson[];
}

export interface PersonEnrichResponse extends EnrichResponseBase {
  entityType: 'person';
  jobTitle: Attributed<string>;
  email: Attributed<string>;
  mobilePhone: Attributed<string>;
  companyName: Attributed<string>;
  companyZoomInfoId: Attributed<string>;
  withinCanada: Attributed<boolean>;
  /** Short professional summary. */
  description: Attributed<string>;
  /** Past and current positions, e.g. "Chief Financial Officer, Example Corp (2019-present)". */
  careerHistory: AttributedValue<string>[];
  /** URLs of the public professional profiles. */
  socialProfiles: AttributedValue<string>[];
  /** Headlines of articles, interviews and talks that feature the person, newest first. */
  newsHeadlines: NewsHeadline[];
}

export type EnrichResponse = CompanyEnrichResponse | PersonEnrichResponse;
