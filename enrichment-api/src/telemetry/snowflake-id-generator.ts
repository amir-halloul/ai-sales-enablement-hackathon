import { randomBytes } from 'node:crypto';
import type { IdGenerator } from '@opentelemetry/sdk-trace';

/**
 * Snowsight's trace viewer (Snowflake Trail) only shows traces whose 16-byte ID starts with
 * the minutes since the epoch (4 bytes, big endian) followed by 12 random bytes.
 */
export class SnowflakeIdGenerator implements IdGenerator {
  generateTraceId(): string {
    const minutes = Math.floor(Date.now() / 60_000);
    return minutes.toString(16).padStart(8, '0') + randomBytes(12).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }
}
