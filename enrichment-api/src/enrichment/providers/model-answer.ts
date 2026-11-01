import { isoDate } from '../../common/iso-date.js';
import type { Address, Confidence, SourceType } from '../enrichment.types.js';
import type { NewsValue, Observation, ObservedValues } from './provider.js';

// Shared by the providers that ask a model for JSON where every value carries its source URL and a confidence.

export type JsonSchema = Record<string, unknown>;
export type Json = Record<string, unknown>;

export const STRING = { type: 'string' };
export const NULLABLE_STRING = { type: ['string', 'null'] };
export const NULLABLE_INTEGER = { type: ['integer', 'null'] };
export const NULLABLE_NUMBER = { type: ['number', 'null'] };
export const CONFIDENCE = { type: 'string', enum: ['low', 'medium', 'high'] };
export const ADDRESS = object({
  street: NULLABLE_STRING,
  city: NULLABLE_STRING,
  state: NULLABLE_STRING,
  postalCode: NULLABLE_STRING,
  country: NULLABLE_STRING,
});
/** Fields of one news article in a cited list; the date is YYYY-MM-DD. */
export const NEWS_ITEM = { headline: STRING, date: NULLABLE_STRING };

/** Collects the values of one answer, keeping only those whose source resolves to a page the model was given. */
export class CitedObservations {
  readonly items: Observation[] = [];
  /** Attributes that had a value without a valid source, which was dropped. */
  readonly uncited = new Set<string>();

  constructor(
    private readonly sourceType: Extract<SourceType, 'web_search' | 'web_page'>,
    private readonly resolveSource: (cited: unknown) => string | undefined,
  ) {}

  add<K extends keyof ObservedValues>(attribute: K, value: ObservedValues[K] | undefined, citation: Json): void {
    if (value === undefined) return;
    const source = this.resolveSource(citation.source);
    if (source === undefined) {
      this.uncited.add(attribute);
      return;
    }
    const confidence = toConfidence(citation.confidence);
    this.items.push({ attribute, value, confidence, source: { sourceType: this.sourceType, sourceReference: source } } as Observation);
  }
}

/** The model's confidence, never above "high": a single web page is not enough for "very_high". */
function toConfidence(value: unknown): Confidence {
  return value === 'high' || value === 'medium' ? value : 'low';
}

/** Adds one field of a facts answer, where each field holds a value with its own source. */
export function addFact<K extends keyof ObservedValues>(
  found: CitedObservations,
  facts: Json,
  attribute: K,
  field: string,
  read: (value: unknown) => ObservedValues[K] | undefined,
): void {
  const fact = record(facts[field]);
  found.add(attribute, read(fact.value), fact);
}

// Schema builders. Every property is required so the model answers each one, with null when it found nothing.

export function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties };
}

/** One value with its source, which are both null when the value was not found. */
export function citedValue(value: JsonSchema): JsonSchema {
  return object({ value, source: NULLABLE_STRING, confidence: CONFIDENCE });
}

/** A list of items, each with its own source. */
export function citedList(item: Record<string, JsonSchema>): JsonSchema {
  return { type: 'array', items: object({ ...item, source: STRING, confidence: CONFIDENCE }) };
}

// Readers for the model's JSON. The schema should guarantee the shape, but the answer is still untrusted input.

export function record(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {};
}

export function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.map(record) : [];
}

export function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

export function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function year(value: unknown): number | undefined {
  const number = positiveInteger(value);
  return number !== undefined && number >= 1000 && number <= new Date().getFullYear() ? number : undefined;
}

export function httpUrl(value: unknown): string | undefined {
  const url = text(value);
  return url && /^https?:\/\/\S+$/i.test(url) ? url : undefined;
}

export function newsItem(article: Json): NewsValue | undefined {
  const headline = text(article.headline);
  return headline ? { headline, date: isoDate(article.date) ?? null } : undefined;
}

export function address(value: unknown): Address | undefined {
  const a = record(value);
  const result: Address = {
    street: text(a.street) ?? null,
    city: text(a.city) ?? null,
    state: text(a.state) ?? null,
    postalCode: text(a.postalCode) ?? null,
    country: text(a.country) ?? null,
  };
  return result.city || result.country ? result : undefined;
}
