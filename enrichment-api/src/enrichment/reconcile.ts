import { maxConfidence, raiseConfidence } from './confidence.js';
import type { Address, AttributedValue, Confidence, EnrichmentWarning, KeyPerson, NewsHeadline, Source, SourceType } from './enrichment.types.js';
import { cleanNews, cleanProducts, headlineKey, productKey } from './list-cleanup.js';
import type { ListAttribute, NewsValue, Observation, ObservedValues, ScalarAttribute, ScalarValues } from './providers/provider.js';

export type ReconciledScalars = { [K in ScalarAttribute]?: AttributedValue<ScalarValues[K]> };

export interface Reconciled {
  scalars: ReconciledScalars;
  lists: Record<ListAttribute, AttributedValue<string>[]>;
  news: NewsHeadline[];
  keyPeople: KeyPerson[];
  warnings: EnrichmentWarning[];
}

/** One provider's statement about one attribute. */
interface Claim<T> {
  value: T;
  confidence: Confidence;
  source: Source;
}

type KeyPersonValue = ObservedValues['keyPeople'];

const LIST_ATTRIBUTES: readonly string[] = [
  'technologies',
  'productsAndServices',
  'competitors',
  'socialProfiles',
  'growthSignals',
  'openPositions',
  'careerHistory',
] satisfies ListAttribute[];

/** Estimates within 10% of each other agree, e.g. 21,000 and 21,100 employees. */
const ESTIMATED_ATTRIBUTES: readonly string[] = ['headcount', 'annualRevenueUsd', 'locationCount'] satisfies ScalarAttribute[];
const ESTIMATE_TOLERANCE = 0.1;

const VENDOR_SOURCES: readonly SourceType[] = ['zoominfo', 'dnb'];
const INDEPENDENT_SOURCES: readonly SourceType[] = ['web_search', 'web_page'];

/**
 * Merges the observations of all providers into one value per attribute, deterministically:
 * - when providers of different source types agree, confidence is raised one level;
 * - when they disagree, the most confident value wins and a conflicting_values warning is added;
 * - when data vendors disagree, a vendor value confirmed by an independent source beats unconfirmed ones;
 * - on a tie, the provider listed first wins;
 * - old news and meaningless products are dropped (see list-cleanup.ts).
 */
export function reconcile(observations: Observation[]): Reconciled {
  const result: Reconciled = {
    scalars: {},
    lists: {
      technologies: [],
      productsAndServices: [],
      competitors: [],
      socialProfiles: [],
      growthSignals: [],
      openPositions: [],
      careerHistory: [],
    },
    news: [],
    keyPeople: [],
    warnings: [],
  };

  for (const [attribute, claims] of groupBy(observations, (o) => o.attribute)) {
    if (attribute === 'keyPeople') {
      result.keyPeople = mergeKeyPeople(claims as Claim<KeyPersonValue>[]);
    } else if (attribute === 'newsHeadlines') {
      result.news = mergeNews(claims as Claim<NewsValue>[]);
    } else if (isListAttribute(attribute)) {
      result.lists[attribute] = mergeList(attribute, claims as Claim<string>[]);
    } else {
      const { value, conflict } = pickValue(attribute, claims as Claim<unknown>[]);
      (result.scalars as Record<string, AttributedValue<unknown>>)[attribute] = value;
      if (conflict) result.warnings.push({ code: 'conflicting_values', provider: null, attribute });
    }
  }

  result.news = cleanNews(result.news);
  result.lists.productsAndServices = cleanProducts(result.lists.productsAndServices, result.scalars.name?.value);
  return result;
}

/** Chooses one value among possibly conflicting claims. */
function pickValue<T>(attribute: string, claims: Claim<T>[]): { value: AttributedValue<T>; conflict: boolean } {
  const alternatives = groupWhere(claims, (a, b) => sameValue(attribute, a.value, b.value));
  const winner = settleVendorConflict(alternatives).reduce((best, candidate) => (isStronger(candidate, best) ? candidate : best));
  const conflict = alternatives.length > 1;
  return { value: combine(winner, { raiseIfCorroborated: !conflict }), conflict };
}

/** Vendor values feed on the same public records, so an independent source decides between them, when there is one. */
function settleVendorConflict<T>(alternatives: Claim<T>[][]): Claim<T>[][] {
  const vendorValues = alternatives.filter((claims) => hasSourceType(claims, VENDOR_SOURCES));
  if (vendorValues.length < 2) return alternatives;

  const confirmed = vendorValues.filter((claims) => hasSourceType(claims, INDEPENDENT_SOURCES));
  if (confirmed.length === 0) return alternatives;
  return confirmed;
}

function hasSourceType(claims: Claim<unknown>[], types: readonly SourceType[]): boolean {
  return claims.some((claim) => types.includes(claim.source.sourceType));
}

/** Lists keep every distinct item; items reported by several providers are combined. */
function mergeList(attribute: ListAttribute, claims: Claim<string>[]): AttributedValue<string>[] {
  const sameItem = groupBy(claims, (c) => listItemKey(attribute, c.value));
  return [...sameItem.values()].map((itemClaims) => combine(itemClaims, { raiseIfCorroborated: true }));
}

function listItemKey(attribute: ListAttribute, value: string): string {
  if (attribute === 'socialProfiles') return normalizeUrl(value);
  if (attribute === 'productsAndServices') return productKey(value);
  return normalizeText(value);
}

/** Headlines that differ only in case or punctuation are one story, dated by the earliest date reported. */
function mergeNews(claims: Claim<NewsValue>[]): NewsHeadline[] {
  const sameStory = groupBy(claims, (c) => headlineKey(c.value.headline));
  return [...sameStory.values()].map((storyClaims) => {
    const headlineClaims = storyClaims.map((c) => ({ ...c, value: c.value.headline }));
    const dates = storyClaims.map((c) => c.value.date);
    return { ...combine(headlineClaims, { raiseIfCorroborated: true }), date: earliestDate(dates) };
  });
}

export function earliestDate(dates: (string | null)[]): string | null {
  const known = dates.filter((date): date is string => date !== null).sort();
  return known[0] ?? null;
}

/**
 * Merges list items found to be the same thing after reconciliation (e.g. by the AI consolidation). Confidence is
 * raised when the merge adds a source type to the strongest item; an item already corroborated is not raised twice.
 */
export function mergeItems<T>(value: T, items: AttributedValue<unknown>[]): AttributedValue<T> {
  const strongest = strongestItem(items);
  const sources = uniqueSources(items.flatMap((item) => item.sources));
  const alreadyRaised = countSourceTypes(strongest.sources) > 1;
  const corroborated = countSourceTypes(sources) > 1;
  return {
    value,
    confidence: corroborated && !alreadyRaised ? raiseConfidence(strongest.confidence) : strongest.confidence,
    sources,
  };
}

/** The most confident item; the first one on a tie. */
function strongestItem(items: AttributedValue<unknown>[]): AttributedValue<unknown> {
  let strongest = items[0];
  for (const item of items) {
    if (maxConfidence(strongest.confidence, item.confidence) !== strongest.confidence) strongest = item;
  }
  return strongest;
}

function countSourceTypes(sources: Source[]): number {
  return new Set(sources.map((s) => s.sourceType)).size;
}

/** People are matched by name; their job title is picked like any other value. */
function mergeKeyPeople(claims: Claim<KeyPersonValue>[]): KeyPerson[] {
  const samePerson = groupBy(claims, (c) => normalizeText(c.value.name));
  return [...samePerson.values()].map((personClaims) => {
    const nameClaims = personClaims.map((c) => ({ ...c, value: c.value.name }));
    const titleClaims = personClaims.map((c) => ({ ...c, value: c.value.jobTitle }));
    return {
      name: combine(nameClaims, { raiseIfCorroborated: true }),
      jobTitle: pickValue('jobTitle', titleClaims).value,
    };
  });
}

/** Combines claims that agree on the same value; the first claim's spelling is kept. */
function combine<T>(claims: Claim<T>[], { raiseIfCorroborated }: { raiseIfCorroborated: boolean }): AttributedValue<T> {
  const confidence = highestConfidence(claims);
  const corroborated = sourceTypeCount(claims) > 1;
  return {
    value: claims[0].value,
    confidence: raiseIfCorroborated && corroborated ? raiseConfidence(confidence) : confidence,
    sources: uniqueSources(claims.map((c) => c.source)),
  };
}

/** Higher confidence wins; on equal confidence, the value backed by more source types wins. */
function isStronger(a: Claim<unknown>[], b: Claim<unknown>[]): boolean {
  const confidenceA = highestConfidence(a);
  const confidenceB = highestConfidence(b);
  if (confidenceA !== confidenceB) return maxConfidence(confidenceA, confidenceB) === confidenceA;
  return sourceTypeCount(a) > sourceTypeCount(b);
}

function highestConfidence(claims: Claim<unknown>[]): Confidence {
  return claims.map((c) => c.confidence).reduce(maxConfidence);
}

function sourceTypeCount(claims: Claim<unknown>[]): number {
  return countSourceTypes(claims.map((c) => c.source));
}

function uniqueSources(sources: Source[]): Source[] {
  const unique = new Map<string, Source>();
  for (const source of sources) unique.set(`${source.sourceType}|${source.sourceReference}`, source);
  return [...unique.values()];
}

function isListAttribute(attribute: string): attribute is ListAttribute {
  return LIST_ATTRIBUTES.includes(attribute);
}

export function sameValue(attribute: string, a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number' && ESTIMATED_ATTRIBUTES.includes(attribute)) {
    return Math.abs(a - b) <= ESTIMATE_TOLERANCE * Math.max(Math.abs(a), Math.abs(b));
  }
  return comparisonKey(attribute, a) === comparisonKey(attribute, b);
}

/** Values that differ only in formatting (case, spacing, URL decoration, phone punctuation) are treated as equal. */
function comparisonKey(attribute: string, value: unknown): string {
  if (attribute === 'address') return addressKey(value as Address);
  if (typeof value !== 'string') return String(value);
  switch (attribute) {
    case 'website':
      return normalizeWebsite(value);
    case 'phone':
      return value.replace(/\D/g, '');
    case 'tickerSymbol':
      // "AMS: WKL" and "WKL" are the same ticker.
      return normalizeText(value).replace(/^.*:\s*/, '');
    default:
      return normalizeText(value);
  }
}

/** Providers format street addresses differently, so only the city and country are compared. */
function addressKey(address: Address): string {
  const country = normalizeText(address.country ?? '').replace(/^the /, '');
  return `${normalizeText(address.city ?? '')}|${country}`;
}

/** "https://www.Example.com/about" and "example.com" both become "example.com". */
export function normalizeWebsite(url: string): string {
  return normalizeUrl(url).replace(/\/.*$/, '');
}

/** "https://www.LinkedIn.com/company/acme/" and "linkedin.com/company/acme" both become "linkedin.com/company/acme". */
function normalizeUrl(url: string): string {
  return normalizeText(url)
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Puts each item in the first group whose first item it matches. */
function groupWhere<T>(items: T[], matches: (a: T, b: T) => boolean): T[][] {
  const groups: T[][] = [];
  for (const item of items) {
    const group = groups.find((g) => matches(g[0], item));
    if (group) group.push(item);
    else groups.push([item]);
  }
  return groups;
}

function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}
