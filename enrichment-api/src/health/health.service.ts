import { Inject, Injectable, Logger } from '@nestjs/common';
import { DnbClient } from '../dnb/dnb.client.js';
import { DnbError } from '../dnb/dnb.errors.js';
import { WebSearchClient } from '../web-search/web-search.client.js';
import { WebSearchError } from '../web-search/web-search.errors.js';
import { ZoomInfoError } from '../zoominfo/zoominfo.errors.js';
import { ZoomInfoService } from '../zoominfo/zoominfo.service.js';

export type DependencyStatus = 'up' | 'down' | 'disabled';

export interface DependencyHealth {
  status: DependencyStatus;
  latencyMs?: number;
  /** Sanitized error code, e.g. auth_failed or timeout. */
  error?: string;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  checkedAt: string;
  dependencies: {
    zoomInfo: DependencyHealth;
    dnb: DependencyHealth;
    webSearch: DependencyHealth;
  };
}

/** Readiness probes call /health every few seconds: upstream checks run at most once per TTL. */
export const HEALTH_CACHE_TTL_MS = 60_000;
const CHECK_TIMEOUT_MS = 5_000;
/** Company search is free (no ZoomInfo credits). */
const ZOOMINFO_PROBE = { website: 'zoominfo.com' };

@Injectable()
export class HealthService {
  private readonly logger = new Logger('Health');
  private cached?: { report: Promise<HealthReport>; expiresAt: number };

  constructor(
    @Inject(ZoomInfoService) private readonly zoomInfo: ZoomInfoService,
    @Inject(DnbClient) private readonly dnb: DnbClient,
    @Inject(WebSearchClient) private readonly webSearch: WebSearchClient,
  ) {}

  /** Concurrent callers share the same in-flight check. */
  check(): Promise<HealthReport> {
    if (!this.cached || Date.now() >= this.cached.expiresAt) {
      this.cached = { report: this.runChecks(), expiresAt: Date.now() + HEALTH_CACHE_TTL_MS };
    }
    return this.cached.report;
  }

  private async runChecks(): Promise<HealthReport> {
    const [zoomInfo, dnb, webSearch] = await Promise.all([this.checkZoomInfo(), this.checkDnb(), this.checkWebSearch()]);
    const dependencies = { zoomInfo, dnb, webSearch };

    let status: HealthReport['status'] = 'ok';
    for (const [name, health] of Object.entries(dependencies)) {
      if (health.status !== 'down') continue;
      status = 'degraded';
      this.logger.warn({ event: 'health.dependency_down', dependency: name, error: health.error });
    }

    return {
      status,
      version: process.env.APP_VERSION ?? 'local',
      checkedAt: new Date().toISOString(),
      dependencies,
    };
  }

  private checkZoomInfo(): Promise<DependencyHealth> {
    if (!this.zoomInfo.isAvailable()) return Promise.resolve({ status: 'disabled' });
    return probe(() => this.zoomInfo.identifyCompany(ZOOMINFO_PROBE, { deadline: Date.now() + CHECK_TIMEOUT_MS }));
  }

  private checkDnb(): Promise<DependencyHealth> {
    if (!this.dnb.isAvailable()) return Promise.resolve({ status: 'disabled' });
    return probe(() => this.dnb.ping({ deadline: Date.now() + CHECK_TIMEOUT_MS }));
  }

  private checkWebSearch(): Promise<DependencyHealth> {
    if (!this.webSearch.isAvailable()) return Promise.resolve({ status: 'disabled' });
    return probe(() => this.webSearch.ping({ deadline: Date.now() + CHECK_TIMEOUT_MS }));
  }
}

async function probe(call: () => Promise<unknown>): Promise<DependencyHealth> {
  const started = Date.now();
  try {
    await call();
    return { status: 'up', latencyMs: Date.now() - started };
  } catch (error) {
    return { status: 'down', latencyMs: Date.now() - started, error: errorCode(error) };
  }
}

function errorCode(error: unknown): string {
  if (error instanceof ZoomInfoError || error instanceof DnbError || error instanceof WebSearchError) return error.code;
  return 'unexpected_error';
}
