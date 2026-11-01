import { Inject, Injectable } from '@nestjs/common';
import { ZOOMINFO_CONFIG, type ZoomInfoConfig } from './zoominfo.config.js';
import { ZoomInfoError } from './zoominfo.errors.js';
import { createBudget, raceBudget, ZoomInfoTransport } from './zoominfo.transport.js';
import type { ZoomInfoBudget } from './zoominfo.types.js';

interface CachedToken {
  value: string;
  expiresAt: number;
}

const OPERATION = 'oauth.token';
const DEFAULT_EXPIRES_IN_S = 300;

@Injectable()
export class ZoomInfoTokenProvider {
  private token?: CachedToken;
  private pending?: Promise<CachedToken>;

  constructor(
    @Inject(ZOOMINFO_CONFIG) private readonly config: ZoomInfoConfig,
    @Inject(ZoomInfoTransport) private readonly transport: ZoomInfoTransport,
  ) {}

  /** Returns a cached token, or fetches one (single-flight). `fresh` is true when it was just issued. */
  async getToken(budget: ZoomInfoBudget): Promise<{ value: string; fresh: boolean }> {
    if (this.token && Date.now() < this.token.expiresAt) {
      return { value: this.token.value, fresh: false };
    }
    this.pending ??= this.fetchToken().finally(() => {
      this.pending = undefined;
    });
    const token = await raceBudget(this.pending, budget, OPERATION);
    return { value: token.value, fresh: true };
  }

  invalidate(value: string): void {
    if (this.token?.value === value) this.token = undefined;
  }

  private async fetchToken(): Promise<CachedToken> {
    const credentials = this.config.credentials;
    if (!credentials) throw new ZoomInfoError('not_configured', { operation: OPERATION });

    const budget = createBudget(this.config.lookupBudgetMs);
    const body = await this.transport.withRetry('token', OPERATION, budget, () =>
      this.transport.send(
        {
          operation: OPERATION,
          kind: 'token',
          url: `${this.config.baseUrl}/oauth/v1/token`,
          headers: {
            Authorization: `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': this.config.userAgent,
          },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            scope: this.config.scopes.join(' '),
          }).toString(),
        },
        budget,
      ),
    );

    const { access_token: value, expires_in: expiresIn } = (body ?? {}) as Record<string, unknown>;
    if (typeof value !== 'string' || value.length === 0) {
      throw new ZoomInfoError('malformed_response', { operation: OPERATION });
    }
    const lifetimeMs =
      (typeof expiresIn === 'number' && Number.isFinite(expiresIn) ? expiresIn : DEFAULT_EXPIRES_IN_S) * 1000;
    this.token = { value, expiresAt: Date.now() + lifetimeMs - this.config.tokenRefreshSkewMs };
    return this.token;
  }
}
