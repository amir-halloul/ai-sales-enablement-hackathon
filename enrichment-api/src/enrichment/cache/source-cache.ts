import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { recordCacheLookup } from '../../telemetry/instruments.js';
import type { ProviderCallOptions, ProviderEnrichResult } from '../providers/provider.js';
import { CACHE_CONFIG, type CacheConfig } from './cache.config.js';

export const CACHE_STORE = Symbol('CACHE_STORE');

/** Bump when the shape of a cached value changes, so older entries are no longer read. */
const FORMAT_VERSION = 1;
/** Writes run after the response is sent, so they get their own time limit. */
const WRITE_TIMEOUT_MS = 20_000;

export interface StoredValue {
  value: unknown;
  fetchedAtMs: number;
}

export interface CacheStore {
  isAvailable(): boolean;
  read(key: string, signal: AbortSignal): Promise<StoredValue | null>;
  write(key: string, source: string, value: unknown, signal: AbortSignal): Promise<void>;
}

export interface CacheEntry<T> {
  /** Picks the TTL, e.g. zoominfo or web_search:news. */
  source: string;
  /** Everything the result depends on; any change makes it another entry. */
  key: unknown[];
  /** Returns null when the stored JSON is not a valid value, which then counts as a miss. */
  read(json: unknown): T | null;
  /** false for results that must not be reused, such as partial ones. */
  keep(value: T): boolean;
}

export interface Cached<T> {
  value: T;
  /** When the cached value was fetched (ISO 8601); null when it was fetched now. */
  fetchedAt: string | null;
}

/** The cache as one request sees it. */
export interface CacheScope {
  through<T>(entry: CacheEntry<T>, fetch: () => Promise<T>, signal: AbortSignal): Promise<Cached<T>>;
}

interface RequestCache {
  refresh: boolean;
  correlationId: string;
  signal: AbortSignal;
}

/** Returns the cached value when there is a fresh one, or fetches it and caches it for the next requests. */
export async function throughCache<T>(options: ProviderCallOptions, entry: CacheEntry<T>, fetch: () => Promise<T>): Promise<Cached<T>> {
  if (!options.cache) return { value: await fetch(), fetchedAt: null };
  return options.cache.through(entry, fetch, options.signal);
}

/** A provider result; only complete ones are kept, so a partial result is fetched again next time. */
export function enrichResultEntry(source: string, key: unknown[]): CacheEntry<ProviderEnrichResult> {
  return { source, key, read: readEnrichResult, keep: (result) => result.matched && result.complete };
}

/** A cached result carries the time it was fetched, which the response reports as retrievedAt. */
export function withFetchTime(cached: Cached<ProviderEnrichResult>): ProviderEnrichResult {
  if (cached.fetchedAt === null) return cached.value;
  return { ...cached.value, retrievedAt: cached.fetchedAt };
}

/**
 * Caches what each source returned, keyed by the source's input, so a repeated enrichment reuses it until the
 * source's TTL expires. Failures of the cache never fail a request: a failed read counts as a miss.
 */
@Injectable()
export class SourceCache {
  private readonly logger = new Logger('SourceCache');

  constructor(
    @Inject(CACHE_CONFIG) private readonly config: CacheConfig,
    @Inject(CACHE_STORE) private readonly store: CacheStore,
  ) {}

  /** refresh skips the reads, but what is fetched is still cached. */
  scope(refresh: boolean, correlationId: string): CacheScope {
    return {
      through: <T>(entry: CacheEntry<T>, fetch: () => Promise<T>, signal: AbortSignal) =>
        this.through(entry, fetch, { refresh, correlationId, signal }),
    };
  }

  private async through<T>(entry: CacheEntry<T>, fetch: () => Promise<T>, request: RequestCache): Promise<Cached<T>> {
    const ttlMs = this.config.ttlsMs.get(entry.source) ?? 0;
    if (ttlMs === 0 || !this.store.isAvailable()) return { value: await fetch(), fetchedAt: null };

    const key = cacheKey(entry);
    if (!request.refresh) {
      const hit = await this.read(key, entry, ttlMs, request);
      recordCacheLookup(entry.source, hit ? 'hit' : 'miss');
      if (hit) return hit;
    }
    const value = await fetch();
    if (entry.keep(value)) this.write(key, entry.source, value, request.correlationId);
    return { value, fetchedAt: null };
  }

  private async read<T>(key: string, entry: CacheEntry<T>, ttlMs: number, request: RequestCache): Promise<Cached<T> | null> {
    try {
      const stored = await this.store.read(key, request.signal);
      if (!stored || Date.now() - stored.fetchedAtMs > ttlMs) return null;
      const value = entry.read(stored.value);
      return value === null ? null : { value, fetchedAt: new Date(stored.fetchedAtMs).toISOString() };
    } catch (error) {
      this.logFailure('cache.read_failed', entry.source, request.correlationId, error);
      return null;
    }
  }

  private write(key: string, source: string, value: unknown, correlationId: string): void {
    this.store
      .write(key, source, value, AbortSignal.timeout(WRITE_TIMEOUT_MS))
      .catch((error: unknown) => this.logFailure('cache.write_failed', source, correlationId, error));
  }

  private logFailure(event: string, source: string, correlationId: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.warn({ event, source, correlationId, detail });
  }
}

function cacheKey(entry: CacheEntry<unknown>): string {
  return createHash('sha256').update(JSON.stringify([FORMAT_VERSION, entry.source, ...entry.key])).digest('hex');
}

function readEnrichResult(json: unknown): ProviderEnrichResult | null {
  if (typeof json !== 'object' || json === null) return null;
  const result = json as Record<string, unknown>;
  const valid =
    typeof result.matched === 'boolean' &&
    typeof result.complete === 'boolean' &&
    Array.isArray(result.observations) &&
    Array.isArray(result.warnings);
  return valid ? (result as unknown as ProviderEnrichResult) : null;
}
