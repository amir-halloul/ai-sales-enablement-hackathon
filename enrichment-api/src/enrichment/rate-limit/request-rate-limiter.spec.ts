import type { IncomingMessage } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnrichmentError } from '../enrichment.errors.js';
import { loadRateLimitConfig } from './rate-limit.config.js';
import { RequestRateLimiter } from './request-rate-limiter.js';

function request(headers: Record<string, string> = {}, remoteAddress = '10.0.0.1'): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function limiter(identify: number, enrich = 0): RequestRateLimiter {
  return new RequestRateLimiter({ perMinute: { identify, enrich } });
}

function rejection(run: () => void): EnrichmentError {
  try {
    run();
  } catch (error) {
    if (error instanceof EnrichmentError) return error;
    throw error;
  }
  throw new Error('expected a rate limit error');
}

describe('RequestRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows a burst up to the limit, then answers 429 with the wait for the next token', () => {
    const rateLimiter = limiter(2);
    rateLimiter.check('identify', request());
    rateLimiter.check('identify', request());

    const error = rejection(() => rateLimiter.check('identify', request()));
    expect(error.getStatus()).toBe(429);
    expect(error).toMatchObject({ code: 'rate_limited', retryAfterMs: 30_000, providers: [] });
  });

  it('refills over time', () => {
    const rateLimiter = limiter(2);
    rateLimiter.check('identify', request());
    rateLimiter.check('identify', request());

    vi.advanceTimersByTime(30_000);
    rateLimiter.check('identify', request());
    expect(() => rateLimiter.check('identify', request())).toThrow(EnrichmentError);
  });

  it('keys by Snowflake user, ignoring case, before the client IP', () => {
    const rateLimiter = limiter(1);
    rateLimiter.check('identify', request({ 'sf-context-current-user': 'alice' }, '10.0.0.1'));

    expect(() => rateLimiter.check('identify', request({ 'sf-context-current-user': 'ALICE' }, '10.0.0.2'))).toThrow(EnrichmentError);
    rateLimiter.check('identify', request({ 'sf-context-current-user': 'bob' }, '10.0.0.1'));
    rateLimiter.check('identify', request({}, '10.0.0.1'));
    expect(() => rateLimiter.check('identify', request({}, '10.0.0.1'))).toThrow(EnrichmentError);
  });

  it('limits each operation separately, and not at all when its limit is 0', () => {
    const rateLimiter = limiter(1, 0);
    rateLimiter.check('identify', request());
    for (let i = 0; i < 100; i++) rateLimiter.check('enrich', request());
  });
});

describe('loadRateLimitConfig', () => {
  it('uses the defaults when unset', () => {
    expect(loadRateLimitConfig({})).toEqual({ perMinute: { identify: 120, enrich: 30 } });
  });

  it('reads both limits', () => {
    const env = { RATE_LIMIT_IDENTIFY_PER_MINUTE: '0', RATE_LIMIT_ENRICH_PER_MINUTE: ' 5 ' };
    expect(loadRateLimitConfig(env)).toEqual({ perMinute: { identify: 0, enrich: 5 } });
  });

  it.each(['-1', '1.5', 'ten', '100001'])('rejects %s', (value) => {
    expect(() => loadRateLimitConfig({ RATE_LIMIT_ENRICH_PER_MINUTE: value })).toThrow(/RATE_LIMIT_ENRICH_PER_MINUTE/);
  });
});
