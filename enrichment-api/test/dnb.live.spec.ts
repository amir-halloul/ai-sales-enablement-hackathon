import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DnbEnrichmentProvider } from '../src/enrichment/providers/dnb.provider.js';
import { loadDnbConfig } from '../src/dnb/dnb.config.js';
import { DnbModule } from '../src/dnb/dnb.module.js';

// Opt-in smoke test against the real D&B API: `npm run test:live` (credentials from .env).
// Every call consumes D&B credits, so it only runs with DNB_LIVE=true.
if (existsSync('.env')) process.loadEnvFile('.env');
const enabled = process.env.DNB_LIVE === 'true' && loadDnbConfig(process.env).credentials !== null;

async function createProvider(): Promise<DnbEnrichmentProvider> {
  const moduleRef = await Test.createTestingModule({ imports: [DnbModule], providers: [DnbEnrichmentProvider] }).compile();
  return moduleRef.get(DnbEnrichmentProvider);
}

const options = () => ({ deadline: Date.now() + 30_000, signal: new AbortController().signal, correlationId: 'live' });
const summary = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

describe.skipIf(!enabled)('D&B (live)', () => {
  it('identifies a company by name, website and country, then enriches it by DUNS', async () => {
    const dnb = await createProvider();

    const identified = await dnb.identify({ entityType: 'company', name: 'Microsoft', website: 'microsoft.com', address: 'Redmond, WA, USA' }, options());
    summary(identified);
    expect(identified.status).toBe('matched');
    const duns = identified.match?.dunsNumber ?? null;
    expect(duns).toMatch(/^\d{9}$/);

    const enriched = await dnb.enrich({ entityType: 'company', zoomInfoId: null, dunsNumber: duns }, options());
    summary(enriched);
    expect(enriched.matched).toBe(true);
  }, 60_000);

  it('reports an unknown DUNS number as not matched', async () => {
    const dnb = await createProvider();

    const enriched = await dnb.enrich({ entityType: 'company', zoomInfoId: null, dunsNumber: '000000000' }, options()).catch((e: unknown) => e);
    summary(enriched);
  }, 30_000);
});
