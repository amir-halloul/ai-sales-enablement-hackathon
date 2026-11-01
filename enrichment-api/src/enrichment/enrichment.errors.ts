import { BadRequestException, HttpException } from '@nestjs/common';
import type { ProviderOutcome } from './enrichment.types.js';
import type { ProviderError } from './providers/provider.js';

export type EnrichmentErrorCode =
  | 'not_found'
  | 'no_provider_available'
  | 'rate_limited'
  | 'timeout'
  | 'upstream_failed'
  | 'entity_store_unavailable';

export class EnrichmentError extends HttpException {
  constructor(
    status: number,
    readonly code: EnrichmentErrorCode,
    message: string,
    readonly providers: ProviderOutcome[],
    readonly retryAfterMs?: number,
  ) {
    super({ statusCode: status, error: code, message, providers }, status);
  }
}

export function noProviderAvailable(providers: ProviderOutcome[]): EnrichmentError {
  return new EnrichmentError(503, 'no_provider_available', 'No provider is available for this request', providers);
}

export function notFound(providers: ProviderOutcome[]): EnrichmentError {
  return new EnrichmentError(404, 'not_found', 'No provider found the entity', providers);
}

export function unknownEntity(): EnrichmentError {
  return new EnrichmentError(404, 'not_found', 'The entityId does not exist', []);
}

export function entityStoreUnavailable(providers: ProviderOutcome[]): EnrichmentError {
  return new EnrichmentError(503, 'entity_store_unavailable', 'The entity store is unavailable', providers);
}

export function tooManyRequests(retryAfterMs: number): EnrichmentError {
  return new EnrichmentError(429, 'rate_limited', 'Too many requests from this caller', [], retryAfterMs);
}

export function invalidRequest(details: string[]): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'invalid_request', message: 'Invalid request', details });
}

/** Picks the status that tells the caller what to do when every provider failed. */
export function allProvidersFailed(errors: ProviderError[], providers: ProviderOutcome[]): EnrichmentError {
  const throttled = errors.every((e) => e.code === 'rate_limited' || e.code === 'quota_exceeded');
  if (throttled) {
    const retryAfterMs = Math.max(0, ...errors.map((e) => e.retryAfterMs ?? 0));
    return new EnrichmentError(429, 'rate_limited', 'Providers are rate limited', providers, retryAfterMs || undefined);
  }

  const timedOut = errors.every((e) => e.code === 'timeout');
  if (timedOut) return new EnrichmentError(504, 'timeout', 'Providers did not respond in time', providers);

  return new EnrichmentError(502, 'upstream_failed', 'Providers failed', providers);
}
