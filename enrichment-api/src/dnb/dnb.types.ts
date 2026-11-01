/** Match criteria: D&B needs a DUNS number, a website, or a name with a country. */
export interface DnbMatchCriteria {
  duns?: string;
  name?: string;
  /** Website domain, e.g. "example.com". */
  url?: string;
  /** ISO 3166 alpha-2 country code. */
  country?: string;
}

export interface DnbCandidate {
  duns: string;
  name?: string;
  /** D&B's match confidence code, from 1 (poor) to 10 (exact, e.g. a DUNS lookup). */
  confidenceCode: number;
}

export interface DnbAddress {
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  /** ISO 3166 alpha-2 country code. */
  countryCode?: string;
}

/** A figure with D&B's reliability, e.g. "Actual", "Estimated" or "Modelled". */
export interface DnbFigure {
  value: number;
  reliability?: string;
}

export interface DnbOrganization {
  duns: string;
  name?: string;
  website?: string;
  phone?: string;
  address?: DnbAddress;
  industry?: string;
  headcount?: DnbFigure;
  revenueUsd?: DnbFigure;
}

export interface DnbMatchResult {
  /** D&B returns only its best candidate, or none. */
  candidate: DnbCandidate | null;
  /** How many candidates D&B found, including those it did not return. */
  candidateCount: number;
  /** The best candidate's data, returned by the same call. */
  organization: DnbOrganization | null;
}
