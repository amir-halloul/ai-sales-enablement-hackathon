export const RATE_LIMIT_CONFIG = Symbol('RATE_LIMIT_CONFIG');

export type RateLimitedOperation = 'identify' | 'enrich';

export interface RateLimitConfig {
  /** Requests per minute per caller and operation; 0 turns the limit off. */
  perMinute: Record<RateLimitedOperation, number>;
}

// Enrich runs every source and consumes credits, so it gets a lower limit than Identify.
const DEFAULT_IDENTIFY_PER_MINUTE = 120;
const DEFAULT_ENRICH_PER_MINUTE = 30;
const MAX_PER_MINUTE = 100_000;

export function loadRateLimitConfig(env: NodeJS.ProcessEnv = process.env): RateLimitConfig {
  return {
    perMinute: {
      identify: readLimit(env, 'RATE_LIMIT_IDENTIFY_PER_MINUTE', DEFAULT_IDENTIFY_PER_MINUTE),
      enrich: readLimit(env, 'RATE_LIMIT_ENRICH_PER_MINUTE', DEFAULT_ENRICH_PER_MINUTE),
    },
  };
}

function readLimit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > MAX_PER_MINUTE) {
    throw new Error(`${name} must be an integer between 0 and ${MAX_PER_MINUTE}`);
  }
  return value;
}
