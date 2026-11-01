import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnowflakeIdGenerator } from './snowflake-id-generator.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('SnowflakeIdGenerator', () => {
  it('starts the trace ID with the minutes since the epoch', () => {
    vi.useFakeTimers({ now: new Date('2026-10-09T12:34:56Z') });

    const traceId = new SnowflakeIdGenerator().generateTraceId();

    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(parseInt(traceId.slice(0, 8), 16)).toBe(Math.floor(Date.parse('2026-10-09T12:34:56Z') / 60_000));
  });

  it('makes random trace and span IDs', () => {
    const generator = new SnowflakeIdGenerator();

    expect(generator.generateTraceId()).not.toBe(generator.generateTraceId());
    expect(generator.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
