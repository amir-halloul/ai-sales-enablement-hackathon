import { DnbError } from './dnb.errors.js';
import type { DnbAddress, DnbCandidate, DnbFigure, DnbMatchResult, DnbOrganization } from './dnb.types.js';

// Reads D&B's JSON defensively: it is untrusted input, and fields are often null or missing.

type Json = Record<string, unknown>;

const HOOVERS_INDUSTRY = 'D&B Hoovers Industry Classification';
const NAICS_INDUSTRY = 'North American Industry Classification System';

export function parseMatchResponse(body: unknown, operation: string): DnbMatchResult {
  if (!isRecord(body)) throw new DnbError('malformed_response', { operation });
  const best = records(body.matchCandidates)[0];
  const candidate = best ? toCandidate(best) : null;
  const embedded = record(record(body.embeddedProduct).organization);
  const hasData = candidate !== null && text(embedded.duns) === candidate.duns;
  return { candidate, candidateCount: candidateCount(body, candidate), organization: hasData ? toOrganization(embedded, candidate.duns) : null };
}

function candidateCount(body: Json, candidate: DnbCandidate | null): number {
  if (typeof body.candidatesMatchedQuantity === 'number') return body.candidatesMatchedQuantity;
  return candidate ? 1 : 0;
}

function toCandidate(raw: Json): DnbCandidate | null {
  const organization = record(raw.organization);
  const duns = text(organization.duns);
  const confidenceCode = record(raw.matchQualityInformation).confidenceCode;
  if (!duns || typeof confidenceCode !== 'number') return null;
  return { duns, name: text(organization.primaryName), confidenceCode };
}

function toOrganization(org: Json, duns: string): DnbOrganization {
  return {
    duns,
    name: text(org.primaryName),
    website: text(record(records(org.websiteAddress)[0]).url),
    phone: phoneNumber(record(records(org.telephone)[0])),
    address: toAddress(record(org.primaryAddress)),
    industry: primaryIndustry(records(org.industryCodes)),
    headcount: headcount(org),
    revenueUsd: revenueUsd(org, duns),
  };
}

/** "+1 4258828080" */
function phoneNumber(telephone: Json): string | undefined {
  const number = text(telephone.telephoneNumber);
  const isdCode = text(telephone.isdCode);
  if (!number) return undefined;
  return isdCode ? `+${isdCode} ${number}` : number;
}

function toAddress(raw: Json): DnbAddress | undefined {
  const street = record(raw.streetAddress);
  const lines = [text(street.line1), text(street.line2)].filter((line) => line !== undefined);
  const address: DnbAddress = {
    street: lines.length > 0 ? lines.join(', ') : undefined,
    city: text(record(raw.addressLocality).name),
    region: text(record(raw.addressRegion).name),
    postalCode: text(raw.postalCode),
    countryCode: text(record(raw.addressCountry).isoAlpha2Code),
  };
  return address.city || address.countryCode ? address : undefined;
}

/** The Hoovers classification has short names like "Software"; NAICS is the fallback. */
function primaryIndustry(codes: Json[]): string | undefined {
  for (const classification of [HOOVERS_INDUSTRY, NAICS_INDUSTRY]) {
    const primary = codes.find((code) => text(code.typeDescription)?.startsWith(classification) && code.priority === 1);
    const description = primary ? text(primary.description) : undefined;
    if (description) return description;
  }
  return undefined;
}

/** The consolidated figure includes the subsidiaries, like the headcount of the other providers. */
function headcount(org: Json): DnbFigure | undefined {
  const figures = records(org.numberOfEmployees);
  const chosen = figures.find((f) => f.informationScopeDescription === 'Consolidated') ?? figures[0];
  return chosen ? toFigure(chosen.value, chosen.reliabilityDescription) : undefined;
}

/** The D&B source returns revenue only for the ultimate parents, so it applies when the company is one of them. */
function revenueUsd(org: Json, duns: string): DnbFigure | undefined {
  const linkage = record(org.corporateLinkage);
  for (const parent of ['globalUltimate', 'domesticUltimate']) {
    if (text(record(linkage[parent]).duns) !== duns) continue;
    const financials = record(records(record(org[parent]).financials)[0]);
    const usd = records(financials.yearlyRevenue).find((revenue) => revenue.currency === 'USD');
    if (usd) return toFigure(usd.value, financials.reliabilityDescription);
  }
  return undefined;
}

function toFigure(value: unknown, reliability: unknown): DnbFigure | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return { value, reliability: text(reliability) };
}

export function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function record(value: unknown): Json {
  return isRecord(value) ? value : {};
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}
