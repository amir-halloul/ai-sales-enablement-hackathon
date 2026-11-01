import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DnbClient } from '../dnb/dnb.client.js';
import { DnbError } from '../dnb/dnb.errors.js';
import type { WebSearchClient } from '../web-search/web-search.client.js';
import { WebSearchError } from '../web-search/web-search.errors.js';
import { ZoomInfoError } from '../zoominfo/zoominfo.errors.js';
import type { ZoomInfoService } from '../zoominfo/zoominfo.service.js';
import { HEALTH_CACHE_TTL_MS, HealthService } from './health.service.js';

type Overrides = { zoomInfo?: Partial<ZoomInfoService>; dnb?: Partial<DnbClient>; webSearch?: Partial<WebSearchClient> };

function setup(overrides: Overrides = {}) {
  const zoomInfo = {
    isAvailable: () => true,
    identifyCompany: vi.fn(() => Promise.resolve({})),
    ...overrides.zoomInfo,
  };
  const dnb = {
    isAvailable: () => true,
    ping: vi.fn(() => Promise.resolve()),
    ...overrides.dnb,
  };
  const webSearch = {
    isAvailable: () => true,
    ping: vi.fn(() => Promise.resolve()),
    ...overrides.webSearch,
  };
  const service = new HealthService(
    zoomInfo as unknown as ZoomInfoService,
    dnb as unknown as DnbClient,
    webSearch as unknown as WebSearchClient,
  );
  return { service, zoomInfo, dnb, webSearch };
}

describe('HealthService', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports ok when every upstream answers', async () => {
    const report = await setup().service.check();
    expect(report).toMatchObject({
      status: 'ok',
      dependencies: { zoomInfo: { status: 'up' }, dnb: { status: 'up' }, webSearch: { status: 'up' } },
    });
  });

  it('reports degraded with the sanitized error code when an upstream fails', async () => {
    const { service } = setup({
      zoomInfo: { identifyCompany: () => Promise.reject(new ZoomInfoError('auth_failed', { status: 401 })) },
      dnb: { ping: () => Promise.reject(new DnbError('upstream_unavailable', { status: 503 })) },
      webSearch: { ping: () => Promise.reject(new WebSearchError('timeout')) },
    });
    const report = await service.check();
    expect(report).toMatchObject({
      status: 'degraded',
      dependencies: {
        zoomInfo: { status: 'down', error: 'auth_failed' },
        dnb: { status: 'down', error: 'upstream_unavailable' },
        webSearch: { status: 'down', error: 'timeout' },
      },
    });
  });

  it('does not call providers that are disabled or not configured', async () => {
    const { service, zoomInfo, dnb, webSearch } = setup({
      zoomInfo: { isAvailable: () => false },
      dnb: { isAvailable: () => false },
      webSearch: { isAvailable: () => false },
    });
    const report = await service.check();
    expect(report).toMatchObject({
      status: 'ok',
      dependencies: { zoomInfo: { status: 'disabled' }, dnb: { status: 'disabled' }, webSearch: { status: 'disabled' } },
    });
    expect(zoomInfo.identifyCompany).not.toHaveBeenCalled();
    expect(dnb.ping).not.toHaveBeenCalled();
    expect(webSearch.ping).not.toHaveBeenCalled();
  });

  it('caches the result so frequent probes do not hit the upstreams', async () => {
    vi.useFakeTimers();
    const { service, zoomInfo, webSearch } = setup();
    await Promise.all([service.check(), service.check()]);
    await service.check();
    expect(zoomInfo.identifyCompany).toHaveBeenCalledTimes(1);
    expect(webSearch.ping).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(HEALTH_CACHE_TTL_MS);
    await service.check();
    expect(zoomInfo.identifyCompany).toHaveBeenCalledTimes(2);
    expect(webSearch.ping).toHaveBeenCalledTimes(2);
  });
});
