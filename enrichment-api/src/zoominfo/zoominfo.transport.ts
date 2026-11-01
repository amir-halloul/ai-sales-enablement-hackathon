import { Inject, Injectable, Logger } from '@nestjs/common';
import { setTimeout as sleep } from 'node:timers/promises';
import { ZOOMINFO_CONFIG, ZOOMINFO_FETCH, type ZoomInfoCallType, type ZoomInfoConfig } from './zoominfo.config.js';
import { ZoomInfoError } from './zoominfo.errors.js';
import type { ZoomInfoBudget, ZoomInfoCallOptions } from './zoominfo.types.js';

export interface ZoomInfoHttpRequest {
  operation: string;
  kind: 'token' | 'data';
  url: string;
  headers: Record<string, string>;
  body: string;
}

type LogFields = Record<string, string | number | undefined>;

export function createBudget(budgetMs: number, options: ZoomInfoCallOptions = {}): ZoomInfoBudget {
  return {
    deadline: Math.min(Date.now() + budgetMs, options.deadline ?? Number.POSITIVE_INFINITY),
    signal: options.signal,
    correlationId: options.correlationId,
  };
}

/** Waits for a shared promise while still honouring this caller's own deadline and cancellation. */
export function raceBudget<T>(promise: Promise<T>, budget: ZoomInfoBudget, operation: string): Promise<T> {
  if (budget.signal?.aborted) return Promise.reject(new ZoomInfoError('cancelled', { operation }));
  const remaining = budget.deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new ZoomInfoError('timeout', { operation }));

  const timeout = AbortSignal.timeout(remaining);
  const signal = budget.signal ? AbortSignal.any([budget.signal, timeout]) : timeout;
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void =>
      reject(new ZoomInfoError(budget.signal?.aborted ? 'cancelled' : 'timeout', { operation }));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

@Injectable()
export class ZoomInfoTransport {
  private readonly logger = new Logger('ZoomInfo');
  private cooldownUntil = 0;

  constructor(
    @Inject(ZOOMINFO_CONFIG) private readonly config: ZoomInfoConfig,
    @Inject(ZOOMINFO_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - Date.now());
  }

  async withRetry<T>(
    callType: ZoomInfoCallType,
    operation: string,
    budget: ZoomInfoBudget,
    attemptFn: () => Promise<T>,
  ): Promise<T> {
    const maxRetries = this.config.retries[callType];
    for (let attempt = 0; ; attempt++) {
      try {
        return await attemptFn();
      } catch (error) {
        if (!(error instanceof ZoomInfoError)) throw error;
        const delayMs = this.retryDelayMs(error, attempt);
        if (delayMs === undefined || attempt >= maxRetries || Date.now() + delayMs >= budget.deadline) {
          throw error;
        }
        this.log('warn', 'retry', {
          operation,
          code: error.code,
          attempt: attempt + 1,
          delayMs: Math.round(delayMs),
          correlationId: budget.correlationId,
        });
        try {
          await sleep(delayMs, undefined, { signal: budget.signal });
        } catch {
          throw new ZoomInfoError('cancelled', { operation });
        }
      }
    }
  }

  async send(request: ZoomInfoHttpRequest, budget: ZoomInfoBudget): Promise<unknown> {
    const { operation } = request;
    const cooldownMs = this.cooldownRemainingMs();
    if (cooldownMs > 0) {
      throw new ZoomInfoError('rate_limited', { operation, retryAfterMs: cooldownMs, retryable: true });
    }
    if (budget.signal?.aborted) throw new ZoomInfoError('cancelled', { operation });
    const remaining = budget.deadline - Date.now();
    if (remaining <= 0) throw new ZoomInfoError('timeout', { operation });

    const timeout = AbortSignal.timeout(remaining);
    const signal = budget.signal ? AbortSignal.any([budget.signal, timeout]) : timeout;
    const started = Date.now();
    try {
      const response = await this.fetchFn(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal,
        redirect: 'error',
      });
      if (!response.ok) throw await this.toHttpError(response, request);
      const body = parseJson(await response.text(), operation);
      this.log('debug', 'request_ok', {
        operation,
        status: response.status,
        durationMs: Date.now() - started,
        correlationId: budget.correlationId,
      });
      return body;
    } catch (error) {
      const err = error instanceof ZoomInfoError ? error : abortOrNetworkError(operation, budget, timeout);
      this.log('warn', 'request_failed', {
        operation,
        code: err.code,
        status: err.details.status,
        upstreamCode: err.details.upstreamCode,
        durationMs: Date.now() - started,
        correlationId: budget.correlationId,
      });
      throw err;
    }
  }

  private async toHttpError(response: Response, request: ZoomInfoHttpRequest): Promise<ZoomInfoError> {
    const { status } = response;
    const operation = request.operation;
    const upstreamCode = extractUpstreamCode(await response.text().catch(() => ''));
    const details = { operation, status, upstreamCode };

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after')) ?? this.config.defaultCooldownMs;
      this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + retryAfterMs);
      const bucket = response.headers.get('x-ratelimit-rejected-bucket') ?? '';
      this.log('warn', 'cooldown', {
        operation,
        retryAfterMs,
        bucket: /^(second|hour|day)$/.test(bucket) ? bucket : undefined,
      });
      return new ZoomInfoError('rate_limited', { ...details, retryAfterMs, retryable: true });
    }
    if (status >= 500 || status === 408) {
      return new ZoomInfoError('upstream_unavailable', { ...details, retryable: true });
    }
    if (request.kind === 'token' || status === 401) return new ZoomInfoError('auth_failed', details);
    if (status === 403) return new ZoomInfoError('entitlement_missing', details);
    if (upstreamCode === 'PFAPI0011') return new ZoomInfoError('quota_exceeded', details);
    return new ZoomInfoError('invalid_request', details);
  }

  private retryDelayMs(error: ZoomInfoError, attempt: number): number | undefined {
    if (!error.retryable) return undefined;
    if (error.details.retryAfterMs !== undefined) return error.details.retryAfterMs;
    if (error.code === 'auth_failed') return 0;
    const base = this.config.retryBaseDelayMs * 2 ** attempt;
    return base / 2 + Math.random() * (base / 2);
  }

  private log(level: 'debug' | 'warn', event: string, fields: LogFields): void {
    this.logger[level]({ event: `zoominfo.${event}`, ...fields });
  }
}

function abortOrNetworkError(operation: string, budget: ZoomInfoBudget, timeout: AbortSignal): ZoomInfoError {
  if (budget.signal?.aborted) return new ZoomInfoError('cancelled', { operation });
  if (timeout.aborted) return new ZoomInfoError('timeout', { operation });
  return new ZoomInfoError('upstream_unavailable', { operation, retryable: true });
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZoomInfoError('malformed_response', { operation });
  }
}

export function parseRetryAfter(value: string | null): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function extractUpstreamCode(text: string): string | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { errors, error } = body as { errors?: unknown; error?: unknown };
  const first: unknown = Array.isArray(errors) ? errors[0] : error;
  const code = typeof first === 'object' && first !== null ? (first as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[A-Z]{2,10}\d{2,6}$/.test(code) ? code : undefined;
}
