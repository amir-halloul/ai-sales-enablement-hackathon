import { registrableDomain } from '../common/registrable-domain.js';
import { maxConfidence } from './confidence.js';
import type {
  EnrichResponse,
  EntityType,
  IdentifyCandidate,
  IdentifyProviderOutcome,
  IdentifyRequest,
  IdentifyResponse,
  ProviderName,
  ProviderOutcome,
} from './enrichment.types.js';
import { encodeEntityId } from './entity-id.js';
import type { EntityRef, ProviderCandidate, ProviderEnrichResult, ProviderIdentifyResult, ScalarAttribute } from './providers/provider.js';
import type { Reconciled } from './reconcile.js';

export type NamedIdentifyResult = ProviderIdentifyResult & { provider: ProviderName };
export type NamedEnrichResult = ProviderEnrichResult & { provider: ProviderName };

/** The entityId is null: the caller assigns it from the entity table. */
export function buildIdentifyResponse(
  request: IdentifyRequest,
  results: NamedIdentifyResult[],
  providers: ProviderOutcome[],
): IdentifyResponse {
  const status = overallStatus(results);
  const confirmed = confirmedMatches(results);
  const match = mergeMatches(confirmed);
  const ids: EntityRef = { entityType: request.entityType, zoomInfoId: match.zoomInfoId ?? null, dunsNumber: match.dunsNumber ?? null };
  const confidences = confirmed.flatMap((r) => (r.matchConfidence ? [r.matchConfidence] : []));
  // Alternatives stay visible even beside a match, which may be a weak one.
  const unconfirmed = results.filter((r) => !confirmed.some((c) => c.provider === r.provider));

  return {
    entityType: request.entityType,
    name: match.name ?? request.name,
    entityId: null,
    zoomInfoId: ids.zoomInfoId,
    dunsNumber: ids.dunsNumber,
    website: match.website ?? null,
    status,
    matchConfidence: confidences.length > 0 ? confidences.reduce(maxConfidence) : null,
    candidates: ambiguousCandidates(request.entityType, unconfirmed),
    providers: providers.map((outcome) => withMatchConfidence(outcome, results)),
    retrievedAt: new Date().toISOString(),
  };
}

function withMatchConfidence(outcome: ProviderOutcome, results: NamedIdentifyResult[]): IdentifyProviderOutcome {
  const result = results.find((r) => r.provider === outcome.provider);
  return { ...outcome, matchConfidence: result?.matchConfidence ?? null };
}

export function buildEnrichResponse(
  entityId: string,
  ref: EntityRef,
  reconciled: Reconciled,
  results: NamedEnrichResult[],
  providers: ProviderOutcome[],
): EnrichResponse {
  const providerWarnings = results.flatMap((r) => r.warnings.map((w) => ({ ...w, provider: r.provider })));
  const value = <K extends ScalarAttribute>(attribute: K) => reconciled.scalars[attribute] ?? null;

  const common = {
    entityId,
    name: value('name'),
    zoomInfoId: value('zoomInfoId'),
    dunsNumber: value('dunsNumber'),
    website: value('website'),
    headcount: value('headcount'),
    annualRevenueUsd: value('annualRevenueUsd'),
    address: value('address'),
    phone: value('phone'),
    completeness: providers.every((p) => p.status === 'ok') ? ('complete' as const) : ('partial' as const),
    warnings: [...providerWarnings, ...reconciled.warnings],
    providers,
    retrievedAt: new Date().toISOString(),
  };

  if (ref.entityType === 'person') {
    return {
      entityType: 'person',
      ...common,
      jobTitle: value('jobTitle'),
      email: value('email'),
      mobilePhone: value('mobilePhone'),
      companyName: value('companyName'),
      companyZoomInfoId: value('companyZoomInfoId'),
      withinCanada: value('withinCanada'),
      description: value('description'),
      careerHistory: reconciled.lists.careerHistory,
      socialProfiles: reconciled.lists.socialProfiles,
      newsHeadlines: reconciled.news,
    };
  }

  return {
    entityType: 'company',
    ...common,
    description: value('description'),
    industry: value('industry'),
    ownershipType: value('ownershipType'),
    tickerSymbol: value('tickerSymbol'),
    locationCount: value('locationCount'),
    foundedYear: value('foundedYear'),
    technologies: reconciled.lists.technologies,
    newsHeadlines: reconciled.news,
    productsAndServices: reconciled.lists.productsAndServices,
    competitors: reconciled.lists.competitors,
    socialProfiles: reconciled.lists.socialProfiles,
    growthSignals: reconciled.lists.growthSignals,
    openPositions: reconciled.lists.openPositions,
    keyPeople: reconciled.keyPeople,
  };
}

function overallStatus(results: NamedIdentifyResult[]): IdentifyResponse['status'] {
  if (results.some((r) => r.status === 'matched')) return 'matched';
  if (results.some((r) => r.status === 'ambiguous')) return 'ambiguous';
  return 'no_match';
}

/**
 * The results that describe the same entity as the first match, in provider order. Another match joins when its
 * website is the same, or when it is a strong match and either website is unknown. A single ambiguous candidate
 * joins only when its website is the same.
 */
function confirmedMatches(results: NamedIdentifyResult[]): NamedIdentifyResult[] {
  const primary = results.find((r) => r.status === 'matched');
  if (!primary) return [];
  const primaryDomain = domainOf(primary.match);
  const confirmed: NamedIdentifyResult[] = [primary];

  for (const result of results) {
    if (result === primary) continue;
    if (result.status === 'matched' && joinsPrimary(result, primaryDomain)) confirmed.push(result);
    if (result.status === 'ambiguous' && result.candidates.length === 1) {
      const [candidate] = result.candidates;
      const corroborated = primaryDomain !== undefined && domainOf(candidate) === primaryDomain;
      if (corroborated) confirmed.push({ ...result, match: candidate, matchConfidence: null });
    }
  }
  return confirmed;
}

function joinsPrimary(result: NamedIdentifyResult, primaryDomain: string | undefined): boolean {
  const domain = domainOf(result.match);
  if (domain !== undefined && primaryDomain !== undefined) return domain === primaryDomain;
  return result.matchConfidence === 'high' || result.matchConfidence === 'very_high';
}

function domainOf(candidate: ProviderCandidate | null | undefined): string | undefined {
  return registrableDomain(candidate?.website);
}

/** For each field, the first provider that has a value wins. */
function mergeMatches(results: NamedIdentifyResult[]): ProviderCandidate {
  const merged: Record<string, string> = {};
  for (const { match } of results) {
    const fields = Object.entries(match ?? {}) as [string, string | undefined][];
    for (const [field, value] of fields) {
      if (value !== undefined) merged[field] ??= value;
    }
  }
  return merged;
}

function ambiguousCandidates(entityType: EntityType, results: NamedIdentifyResult[]): IdentifyCandidate[] {
  const candidates: IdentifyCandidate[] = [];
  for (const result of results) {
    if (result.status !== 'ambiguous') continue;

    for (const candidate of result.candidates) {
      const zoomInfoId = candidate.zoomInfoId ?? null;
      const dunsNumber = candidate.dunsNumber ?? null;
      // A candidate without any ID could not be enriched afterwards.
      if (zoomInfoId === null && dunsNumber === null) continue;

      candidates.push({
        entityId: encodeEntityId({ entityType, zoomInfoId, dunsNumber }),
        zoomInfoId,
        dunsNumber,
        name: candidate.name ?? null,
        website: candidate.website ?? null,
        location: candidate.location ?? null,
        company: candidate.company ?? null,
        jobTitle: candidate.jobTitle ?? null,
        sources: [{ sourceType: result.provider, sourceReference: sourceReference(result.provider, zoomInfoId, dunsNumber) }],
      });
    }
  }
  return candidates;
}

function sourceReference(provider: ProviderName, zoomInfoId: string | null, dunsNumber: string | null): string | null {
  if (provider === 'zoominfo') return zoomInfoId;
  if (provider === 'dnb') return dunsNumber;
  return null;
}
