import { Logger } from '@nestjs/common';
import { SpanStatusCode } from '@opentelemetry/api';
import { recordProviderCall, tracer } from '../telemetry/instruments.js';
import type { CacheScope } from './cache/source-cache.js';
import type { ProviderName } from './enrichment.types.js';
import { ProviderError, type ProviderCallOptions } from './providers/provider.js';

export type ProviderCall<T> =
  | { provider: ProviderName; ok: true; value: T; retrievedAt: string }
  | { provider: ProviderName; ok: false; error: ProviderError };

export interface CallBudget {
  /** Absolute deadline (epoch ms) of the API request. */
  deadline: number;
  /** Aborted when the caller disconnects. */
  signal: AbortSignal;
  correlationId: string;
  cache?: CacheScope;
}

const logger = new Logger('EnrichmentService');

/**
 * Calls the providers in parallel and never rejects: each failure is returned as a ProviderError.
 * A provider still running at the deadline is abandoned and reported as a timeout.
 */
export function callProviders<P extends { name: ProviderName }, T>(
  providers: P[],
  call: (provider: P, options: ProviderCallOptions) => Promise<T>,
  budget: CallBudget,
): Promise<ProviderCall<T>[]> {
  const signal = AbortSignal.any([budget.signal, AbortSignal.timeout(Math.max(0, budget.deadline - Date.now()))]);
  const options: ProviderCallOptions = { deadline: budget.deadline, signal, correlationId: budget.correlationId, cache: budget.cache };

  return Promise.all(providers.map((provider) => callProvider(provider, call, options, budget)));
}

/** One span per provider call, so its HTTP requests and cache reads nest under it in the trace. */
function callProvider<P extends { name: ProviderName }, T>(
  provider: P,
  call: (provider: P, options: ProviderCallOptions) => Promise<T>,
  options: ProviderCallOptions,
  budget: CallBudget,
): Promise<ProviderCall<T>> {
  const started = Date.now();
  return tracer.startActiveSpan(`provider ${provider.name}`, async (span): Promise<ProviderCall<T>> => {
    span.setAttributes({ 'enrichment.provider': provider.name, 'enrichment.correlation_id': budget.correlationId });
    try {
      const value = await rejectOnAbort(call(provider, options), options.signal);
      recordProviderCall(provider.name, 'ok', Date.now() - started);
      return { provider: provider.name, ok: true, value, retrievedAt: new Date().toISOString() };
    } catch (error) {
      const providerError = toProviderError(error, provider.name, budget);
      recordProviderCall(provider.name, providerError.code, Date.now() - started);
      span.setStatus({ code: SpanStatusCode.ERROR, message: providerError.code });
      return { provider: provider.name, ok: false, error: providerError };
    } finally {
      span.end();
    }
  });
}

function rejectOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

function toProviderError(error: unknown, provider: ProviderName, budget: CallBudget): ProviderError {
  if (error instanceof ProviderError) return error;
  if (budget.signal.aborted) return new ProviderError('cancelled');
  if (error instanceof DOMException && error.name === 'TimeoutError') return new ProviderError('timeout');

  // Anything else is a bug in a provider adapter.
  const stack = error instanceof Error ? error.stack : undefined;
  logger.error({ event: 'provider.unexpected_error', provider, correlationId: budget.correlationId }, stack);
  return new ProviderError('internal_error');
}
