import { metrics, trace } from '@opentelemetry/api';

// Created at import time, which register.ts guarantees is after the SDK started (otherwise they are no-ops).
const meter = metrics.getMeter('enrichment-api');

export const tracer = trace.getTracer('enrichment-api');

const requests = meter.createCounter('enrichment.requests', { description: 'API requests by operation and result' });
const requestDuration = meter.createHistogram('enrichment.request.duration', { unit: 'ms', description: 'API request duration' });
const providerCalls = meter.createCounter('enrichment.provider.calls', { description: 'Provider calls by provider and status' });
const providerDuration = meter.createHistogram('enrichment.provider.duration', { unit: 'ms', description: 'Provider call duration' });
const cacheLookups = meter.createCounter('enrichment.cache.lookups', { description: 'Source cache lookups by source and result' });

/** result is "ok" or the error code returned to the caller. */
export function recordRequest(operation: string, result: string, durationMs: number): void {
  const attributes = { operation, result };
  requests.add(1, attributes);
  requestDuration.record(durationMs, attributes);
}

/** status is "ok" or the ProviderError code. */
export function recordProviderCall(provider: string, status: string, durationMs: number): void {
  const attributes = { provider, status };
  providerCalls.add(1, attributes);
  providerDuration.record(durationMs, attributes);
}

/** A failed read counts as a miss, like it does for the request. */
export function recordCacheLookup(source: string, result: 'hit' | 'miss'): void {
  cacheLookups.add(1, { source, result });
}
