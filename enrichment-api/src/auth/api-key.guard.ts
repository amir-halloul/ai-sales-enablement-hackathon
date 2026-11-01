import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Injectable, Logger, UnauthorizedException, type CanActivate, type ExecutionContext } from '@nestjs/common';

const API_KEY_HEADER = 'x-api-key';

/**
 * Callers (the Salesforce Named Credential) send the shared API_KEY in the X-API-Key header.
 * Replaces the Snowflake ingress authentication; without API_KEY every request is rejected.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly expected: Buffer | null;

  constructor() {
    const key = process.env.API_KEY?.trim();
    this.expected = key ? digest(key) : null;
    if (!this.expected) new Logger('Auth').warn({ event: 'auth.api_key_missing' });
  }

  canActivate(context: ExecutionContext): boolean {
    const header = context.switchToHttp().getRequest<IncomingMessage>().headers[API_KEY_HEADER];
    // Comparing digests keeps the comparison constant-time whatever the header length.
    if (this.expected && typeof header === 'string' && timingSafeEqual(digest(header), this.expected)) return true;
    throw new UnauthorizedException({ statusCode: 401, error: 'unauthorized', message: 'A valid X-API-Key header is required' });
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
