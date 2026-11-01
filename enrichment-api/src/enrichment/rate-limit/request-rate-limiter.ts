import type { IncomingMessage } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { tooManyRequests } from '../enrichment.errors.js';
import { RATE_LIMIT_CONFIG, type RateLimitConfig, type RateLimitedOperation } from './rate-limit.config.js';

/** Set by the SPCS ingress to the Snowflake user that sent the request. */
const CALLER_HEADER = 'sf-context-current-user';
const MAX_CALLER_LENGTH = 256;
const MAX_TRACKED_BUCKETS = 10_000;
const MINUTE_MS = 60_000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token bucket per caller and operation, kept in memory: each service instance limits on its own.
 * A caller can burst up to the per-minute limit, then gets one request every 60 s / limit.
 */
@Injectable()
export class RequestRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(@Inject(RATE_LIMIT_CONFIG) private readonly config: RateLimitConfig) {}

  /** Throws a 429 EnrichmentError, with the wait until the next token, when the caller is over its limit. */
  check(operation: RateLimitedOperation, req: IncomingMessage): void {
    const limit = this.config.perMinute[operation];
    if (limit === 0) return;

    const now = Date.now();
    const bucket = this.refilledBucket(`${operation}:${callerKey(req)}`, limit, now);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }
    const tokensPerMs = limit / MINUTE_MS;
    throw tooManyRequests(Math.ceil((1 - bucket.tokens) / tokensPerMs));
  }

  private refilledBucket(key: string, limit: number, now: number): Bucket {
    const existing = this.buckets.get(key);
    if (existing) {
      const refill = ((now - existing.updatedAt) * limit) / MINUTE_MS;
      existing.tokens = Math.min(limit, existing.tokens + refill);
      existing.updatedAt = now;
      return existing;
    }

    if (this.buckets.size >= MAX_TRACKED_BUCKETS) this.evictBuckets(now);
    const bucket = { tokens: limit, updatedAt: now };
    this.buckets.set(key, bucket);
    return bucket;
  }

  /** Drops buckets idle for a minute (they are full again), or else the oldest one. */
  private evictBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= MINUTE_MS) this.buckets.delete(key);
    }
    if (this.buckets.size < MAX_TRACKED_BUCKETS) return;
    const oldestKey = this.buckets.keys().next().value;
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}

/** The Snowflake user behind the ingress, or the client IP for direct (service-to-service or local) calls. */
function callerKey(req: IncomingMessage): string {
  const user = req.headers[CALLER_HEADER];
  if (typeof user === 'string' && user.trim()) {
    return `user:${user.trim().toUpperCase().slice(0, MAX_CALLER_LENGTH)}`;
  }
  return `ip:${req.socket.remoteAddress ?? 'unknown'}`;
}
