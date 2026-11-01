import type { ZoomInfoErrorCode } from './zoominfo.errors.js';

export interface ZoomInfoCallOptions {
  /** Caller cancellation (client disconnect, overall request abort). */
  signal?: AbortSignal;
  /** Absolute deadline (epoch ms) of the overall API request; ZoomInfo budgets are capped by it. */
  deadline?: number;
  correlationId?: string;
}

export interface ZoomInfoBudget {
  deadline: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface ZoomInfoSourceRef {
  sourceType: 'zoominfo';
  sourceReference: string | null;
}

export interface ZoomInfoWarning {
  section: 'profile' | 'technologies' | 'keyPeople' | 'news';
  code: ZoomInfoErrorCode | 'upstream_warning';
  upstreamCode?: string;
}

export type IdentifyStatus = 'matched' | 'ambiguous' | 'no_match';
export type MatchBasis = 'zoominfo_id' | 'single_candidate' | 'exact_domain' | 'exact_name';

export interface IdentifyResult<T> {
  provider: 'zoominfo';
  entityType: 'company' | 'person';
  retrievedAt: string;
  status: IdentifyStatus;
  matchBasis: MatchBasis | null;
  match: T | null;
  candidates: T[];
  totalResults: number;
  source: ZoomInfoSourceRef;
}

export interface CompanyIdentifyInput {
  zoomInfoId?: string;
  name?: string;
  website?: string;
  /** English name, e.g. "Canada"; narrows a name search to companies headquartered there. */
  country?: string;
}

export interface CompanyCandidate {
  zoomInfoId: string;
  name?: string;
  website?: string;
  city?: string;
  state?: string;
  country?: string;
  employeeCount?: string;
  revenue?: string;
}

export interface PersonIdentifyInput {
  zoomInfoId?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  jobTitle?: string;
  companyZoomInfoId?: string;
  companyName?: string;
  companyWebsite?: string;
}

export interface PersonCandidate {
  zoomInfoId: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  jobTitle?: string;
  managementLevel: string[];
  contactAccuracyScore?: number;
  lastUpdatedDate?: string;
  company: { zoomInfoId?: string; name?: string } | null;
}

export type CompanyIdentifyResult = IdentifyResult<CompanyCandidate> & { entityType: 'company' };
export type PersonIdentifyResult = IdentifyResult<PersonCandidate> & { entityType: 'person' };

export interface CodeName {
  id?: string;
  name?: string;
}

export interface CompanyRef {
  zoomInfoId?: string;
  name?: string;
}

export interface FundingRound {
  date?: string;
  type?: string;
  amountThousandsUsd?: number;
  investors: string[];
}

export interface Competitor {
  zoomInfoId?: string;
  name?: string;
  website?: string;
  rank?: number;
  headcount?: number;
}

export interface CompanyProfile {
  zoomInfoId: string;
  name?: string;
  website?: string;
  domains: string[];
  description?: string;
  logoUrl?: string;
  phone?: string;
  address: {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
    continent?: string;
    metroArea?: string;
  };
  locationCount?: number;
  headcount?: number;
  employeeRange?: string;
  employeeGrowth: {
    oneYearRate?: string;
    twoYearRate?: string;
    quarterly: { label?: string; headcount?: number }[];
  } | null;
  headcountByDepartment: Record<string, number>;
  /** Approximate yearly revenue in thousands of USD, as reported by ZoomInfo. */
  revenueThousandsUsd?: number;
  revenueRange?: string;
  /** ZoomInfo estimates; units are not documented (values are consistent with thousands of USD). */
  departmentBudgets: Record<string, number>;
  funding: {
    totalThousandsUsd?: number;
    mostRecentThousandsUsd?: number;
    mostRecentDate?: string;
    rounds: FundingRound[];
  };
  /** private, public, npo, education, government or other. */
  ownershipType?: string;
  ticker?: string;
  foundedYear?: string;
  businessModel: string[];
  primaryIndustry: string[];
  primaryIndustryCodes: CodeName[];
  primarySubIndustryCodes: CodeName[];
  industries: string[];
  industryCodes: CodeName[];
  sicCodes: CodeName[];
  naicsCodes: CodeName[];
  productsAndServices: string[];
  competitors: Competitor[];
  subUnitType?: string;
  parent: CompanyRef | null;
  ultimateParent: (CompanyRef & { revenueThousandsUsd?: number; headcount?: number }) | null;
  companyStatus?: string;
  companyStatusDate?: string;
  isDefunct?: boolean;
  certified?: boolean;
  socialMediaUrls: { type?: string; url: string; followerCount?: number }[];
  lastUpdatedDate?: string;
}

export interface Technology {
  zoomInfoId: string;
  product?: string;
  vendor?: string;
  category?: string;
  categoryParent?: string;
}

export interface KeyPerson {
  zoomInfoId: string;
  name: string;
  jobTitle?: string;
  managementLevel: string[];
  contactAccuracyScore?: number;
}

export interface NewsArticle {
  zoomInfoId: string;
  title?: string;
  url?: string;
  domain?: string;
  publishedAt?: string;
  summary?: string;
  categories: string[];
}

export interface EvidenceSection<T> {
  status: 'ok' | 'failed' | 'skipped';
  retrievedAt: string | null;
  error: ZoomInfoErrorCode | null;
  items: T[];
}

export interface CompanyEnrichInput {
  zoomInfoId: string;
}

export interface CompanyEnrichOptions extends ZoomInfoCallOptions {
  include?: { technologies?: boolean; keyPeople?: boolean; news?: boolean };
}

export interface CompanyEnrichResult {
  provider: 'zoominfo';
  entityType: 'company';
  retrievedAt: string;
  source: ZoomInfoSourceRef;
  status: 'matched' | 'no_match';
  matchStatus: string;
  completeness: 'complete' | 'partial';
  warnings: ZoomInfoWarning[];
  profile: CompanyProfile | null;
  technologies: EvidenceSection<Technology>;
  keyPeople: EvidenceSection<KeyPerson>;
  news: EvidenceSection<NewsArticle>;
}

export interface PersonEnrichInput {
  zoomInfoId: string;
}

export interface PersonProfile {
  zoomInfoId: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  jobTitle?: string;
  jobFunctions: { name?: string; department?: string }[];
  managementLevel: string[];
  positionStartDate?: string;
  email?: string;
  phone?: string;
  mobilePhone?: string;
  doNotCall: { phone?: boolean; mobilePhone?: boolean };
  location: {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    country?: string;
    metroArea?: string;
  };
  /** Privacy-relevant jurisdiction flags reported by ZoomInfo. */
  jurisdiction: { withinCanada?: boolean; hasCanadianEmail?: boolean; withinEu?: boolean; withinCalifornia?: boolean };
  externalUrls: { type?: string; url: string }[];
  contactAccuracyScore?: number;
  employmentHistory: {
    jobTitle?: string;
    fromDate?: string;
    toDate?: string;
    company: { zoomInfoId?: string; name?: string; website?: string } | null;
  }[];
  personHasMoved?: string;
  isDefunct?: boolean;
  lastUpdatedDate?: string;
  validDate?: string;
  company: PersonCompany | null;
}

export interface PersonCompany extends CompanyRef {
  website?: string;
  ownershipType?: string;
  ticker?: string;
  phone?: string;
  address: { street?: string; city?: string; state?: string; zipCode?: string; country?: string };
  headcount?: number;
  employeeRange?: string;
  /** Unlike CompanyProfile, the contact endpoint reports revenue in USD. */
  revenueUsd?: number;
  revenueRange?: string;
  primaryIndustry: string[];
  industries: string[];
}

export interface PersonEnrichResult {
  provider: 'zoominfo';
  entityType: 'person';
  retrievedAt: string;
  source: ZoomInfoSourceRef;
  status: 'matched' | 'no_match';
  matchStatus: string;
  warnings: ZoomInfoWarning[];
  profile: PersonProfile | null;
}
