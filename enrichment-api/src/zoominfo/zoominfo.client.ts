import { Inject, Injectable } from '@nestjs/common';
import { ZOOMINFO_CONFIG, type ZoomInfoCallType, type ZoomInfoConfig } from './zoominfo.config.js';
import { ZoomInfoError } from './zoominfo.errors.js';
import { ZoomInfoTokenProvider } from './zoominfo-token.provider.js';
import { ZoomInfoTransport } from './zoominfo.transport.js';
import type { ZoomInfoBudget } from './zoominfo.types.js';

export interface ZoomInfoDataRequest {
  operation: string;
  callType: ZoomInfoCallType;
  path: string;
  type: string;
  attributes: Record<string, unknown>;
  query?: Record<string, string | number>;
}

const JSON_API = 'application/vnd.api+json';

@Injectable()
export class ZoomInfoClient {
  constructor(
    @Inject(ZOOMINFO_CONFIG) private readonly config: ZoomInfoConfig,
    @Inject(ZoomInfoTransport) private readonly transport: ZoomInfoTransport,
    @Inject(ZoomInfoTokenProvider) private readonly tokens: ZoomInfoTokenProvider,
  ) {}

  post(request: ZoomInfoDataRequest, budget: ZoomInfoBudget): Promise<unknown> {
    const { operation } = request;
    const url = new URL(`${this.config.baseUrl}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, String(value));
    const body = JSON.stringify({ data: { type: request.type, attributes: request.attributes } });

    return this.transport.withRetry(request.callType, operation, budget, async () => {
      const token = await this.tokens.getToken(budget);
      try {
        return await this.transport.send(
          {
            operation,
            kind: 'data',
            url: url.toString(),
            headers: {
              Authorization: `Bearer ${token.value}`,
              'Content-Type': JSON_API,
              Accept: JSON_API,
              'User-Agent': this.config.userAgent,
            },
            body,
          },
          budget,
        );
      } catch (error) {
        if (error instanceof ZoomInfoError && error.code === 'auth_failed') {
          this.tokens.invalidate(token.value);
          // A cached token may have been revoked early: allow one refresh within the retry budget.
          if (!token.fresh) throw new ZoomInfoError('auth_failed', { ...error.details, retryable: true });
        }
        throw error;
      }
    });
  }
}
