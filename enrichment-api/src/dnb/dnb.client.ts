import { Inject, Injectable, Logger } from '@nestjs/common';
import { parseRetryAfter } from '../zoominfo/zoominfo.transport.js';
import { DNB_CONFIG, DNB_FETCH, type DnbConfig } from './dnb.config.js';
import { DnbError } from './dnb.errors.js';
import { parseMatchResponse, record } from './dnb.parser.js';
import type { DnbMatchCriteria, DnbMatchResult } from './dnb.types.js';

const TOKEN_PATH = '/v2/token';
const MATCH_ENRICH_PATH = '/v1/connect/matchEnrich/v2/';
/** Renew the token a little before D&B expires it. */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60_000;
/** D&B tokens last 24 hours; used when the response does not say. */
const DEFAULT_TOKEN_LIFETIME_MS = 24 * 60 * 60_000;
/** Enough of D&B's error message to diagnose a bad request or a missing entitlement. */
const MAX_ERROR_DETAIL = 300;

export interface DnbCallOptions {
  /** Absolute deadline (epoch ms). */
  deadline: number;
  signal: AbortSignal;
  correlationId?: string;
}

interface DnbRequest {
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

type LogFields = Record<string, string | number | undefined>;

/** Calls D&B Direct+ "match and enrich": one call finds the best match and returns its data. */
@Injectable()
export class DnbClient {
  private readonly logger = new Logger('DnB');
  private token: CachedToken | null = null;
  /** Concurrent callers share one token request. */
  private pendingToken: Promise<string> | null = null;

  constructor(
    @Inject(DNB_CONFIG) private readonly config: DnbConfig,
    @Inject(DNB_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  isAvailable(): boolean {
    return this.config.enabled && this.config.credentials !== null;
  }

  async matchEnrich(criteria: DnbMatchCriteria, options: DnbCallOptions): Promise<DnbMatchResult> {
    const operation = criteria.duns ? 'matchEnrich.duns' : 'matchEnrich.match';
    if (!this.config.enabled) throw new DnbError('disabled', { operation });
    if (!this.config.credentials) throw new DnbError('not_configured', { operation });
    const url = `${this.config.baseUrl}${MATCH_ENRICH_PATH}${this.config.matchSource}?${matchQuery(criteria)}`;
    const body = await this.getWithToken(url, operation, options);
    return parseMatchResponse(body, operation);
  }

  async ping(options: { deadline: number }): Promise<void> {
    const operation = 'ping';
    if (!this.config.enabled) throw new DnbError('disabled', { operation });
    const timeout = AbortSignal.timeout(Math.max(0, options.deadline - Date.now()));
    let status: number;
    try {
      const response = await this.fetchFn(this.config.baseUrl + TOKEN_PATH, { method: 'POST', signal: timeout, redirect: 'error' });
      await response.body?.cancel();
      status = response.status;
    } catch {
      throw abortOrNetworkError(operation, new AbortController().signal, timeout);
    }
    if (status === 429) throw new DnbError('rate_limited', { operation, status });
    if (status >= 500) throw new DnbError('upstream_unavailable', { operation, status });
    await this.getToken({ deadline: options.deadline, signal: timeout });
  }

  /** A cached token that D&B rejects (e.g. revoked early) is replaced once. */
  private async getWithToken(url: string, operation: string, options: DnbCallOptions): Promise<unknown> {
    const token = await this.getToken(options);
    try {
      return await this.send(url, bearerRequest(token.value), operation, options);
    } catch (error) {
      const rejectedToken = error instanceof DnbError && error.code === 'auth_failed';
      if (!rejectedToken || token.fresh) throw error;
      this.invalidate(token.value);
      const fresh = await this.getToken(options);
      return this.send(url, bearerRequest(fresh.value), operation, options);
    }
  }

  private async getToken(options: DnbCallOptions): Promise<{ value: string; fresh: boolean }> {
    if (this.token && Date.now() < this.token.expiresAt) return { value: this.token.value, fresh: false };
    this.pendingToken ??= this.fetchToken(options.correlationId).finally(() => {
      this.pendingToken = null;
    });
    return { value: await this.pendingToken, fresh: true };
  }

  private invalidate(value: string): void {
    if (this.token?.value === value) this.token = null;
  }

  /** Not tied to one caller's signal, because concurrent callers share it. */
  private async fetchToken(correlationId: string | undefined): Promise<string> {
    const operation = 'token';
    const { credentials } = this.config;
    if (!credentials) throw new DnbError('not_configured', { operation });
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
    const request: DnbRequest = {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials' }),
    };
    const options = { deadline: Date.now() + this.config.requestTimeoutMs, signal: new AbortController().signal, correlationId };
    const body = record(await this.send(this.config.baseUrl + TOKEN_PATH, request, operation, options));
    if (typeof body.access_token !== 'string' || body.access_token === '') throw new DnbError('malformed_response', { operation });
    const lifetimeMs = typeof body.expiresIn === 'number' && body.expiresIn > 0 ? body.expiresIn * 1000 : DEFAULT_TOKEN_LIFETIME_MS;
    this.token = { value: body.access_token, expiresAt: Date.now() + lifetimeMs - TOKEN_RENEWAL_MARGIN_MS };
    return body.access_token;
  }

  private async send(url: string, request: DnbRequest, operation: string, options: DnbCallOptions): Promise<unknown> {
    if (options.signal.aborted) throw new DnbError('cancelled', { operation });
    const remaining = Math.min(options.deadline - Date.now(), this.config.requestTimeoutMs);
    if (remaining <= 0) throw new DnbError('timeout', { operation });
    const timeout = AbortSignal.timeout(remaining);
    const started = Date.now();
    try {
      const response = await this.fetchFn(url, { ...request, signal: AbortSignal.any([options.signal, timeout]), redirect: 'error' });
      const text = await response.text();
      if (!response.ok) throw this.httpError(response, text, operation, options.correlationId);
      const body = parseJson(text, operation);
      this.log('debug', 'request_ok', { operation, durationMs: Date.now() - started, correlationId: options.correlationId });
      return body;
    } catch (error) {
      const err = error instanceof DnbError ? error : abortOrNetworkError(operation, options.signal, timeout);
      this.log('warn', 'request_failed', {
        operation,
        code: err.code,
        status: err.details.status,
        upstreamCode: err.details.upstreamCode,
        durationMs: Date.now() - started,
        correlationId: options.correlationId,
      });
      throw err;
    }
  }

  private httpError(response: Response, text: string, operation: string, correlationId: string | undefined): DnbError {
    const { status } = response;
    const upstream = upstreamError(text);
    this.log('warn', 'http_error', { operation, status, upstreamCode: upstream.code, detail: upstream.message, correlationId });
    const details = { operation, status, upstreamCode: upstream.code };
    if (status === 429) {
      return new DnbError('rate_limited', { ...details, retryAfterMs: parseRetryAfter(response.headers.get('retry-after')) });
    }
    if (status >= 500 || status === 408) return new DnbError('upstream_unavailable', details);
    if (status === 401) return new DnbError('auth_failed', details);
    if (status === 403) return new DnbError('entitlement_missing', details);
    return new DnbError('invalid_request', details);
  }

  private log(level: 'debug' | 'warn', event: string, fields: LogFields): void {
    this.logger[level]({ event: `dnb.${event}`, ...fields });
  }
}

function matchQuery(criteria: DnbMatchCriteria): string {
  const query = new URLSearchParams();
  if (criteria.duns) query.set('duns', criteria.duns);
  if (criteria.name) query.set('name', criteria.name);
  if (criteria.url) query.set('url', criteria.url);
  if (criteria.country) query.set('country', criteria.country);
  return query.toString();
}

function bearerRequest(token: string): DnbRequest {
  return { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } };
}

/** D&B errors look like {"error":{"errorCode":"CONNECT_001","errorMessage":"..."}}. */
function upstreamError(text: string): { code?: string; message?: string } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {};
  }
  const error = record(record(body).error);
  return {
    code: typeof error.errorCode === 'string' ? error.errorCode : undefined,
    message: typeof error.errorMessage === 'string' ? error.errorMessage.slice(0, MAX_ERROR_DETAIL) : undefined,
  };
}

function abortOrNetworkError(operation: string, signal: AbortSignal, timeout: AbortSignal): DnbError {
  if (signal.aborted) return new DnbError('cancelled', { operation });
  if (timeout.aborted) return new DnbError('timeout', { operation });
  return new DnbError('upstream_unavailable', { operation });
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DnbError('malformed_response', { operation });
  }
}
