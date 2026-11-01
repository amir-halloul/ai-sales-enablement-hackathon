import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadZoomInfoConfig, ZOOMINFO_FETCH } from '../src/zoominfo/zoominfo.config.js';
import { ZoomInfoModule } from '../src/zoominfo/zoominfo.module.js';
import { ZoomInfoService } from '../src/zoominfo/zoominfo.service.js';

// Opt-in smoke test against the real ZoomInfo API: `npm run test:live` (credentials from .env).
// Searches are free; enrich tests consume credits and only run with ZOOMINFO_LIVE_ENRICH=true.
// ZOOMINFO_LIVE_RAW=true also prints the raw data requests and responses (never the token call).
if (existsSync('.env')) process.loadEnvFile('.env');
const configured = loadZoomInfoConfig(process.env).credentials !== null;
const enrichEnabled = process.env.ZOOMINFO_LIVE_ENRICH === 'true';
const rawEnabled = process.env.ZOOMINFO_LIVE_RAW === 'true';

const rawFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : input);
  if (!url.pathname.endsWith('/token')) {
    const body = typeof init?.body === 'string' ? init.body : '';
    console.log(`RAW ${url.pathname}${url.search} -> ${response.status}\nrequest: ${body}\nresponse: ${await response.clone().text()}`);
  }
  return response;
};

async function createService(): Promise<ZoomInfoService> {
  const builder = Test.createTestingModule({ imports: [ZoomInfoModule] });
  if (rawEnabled) builder.overrideProvider(ZOOMINFO_FETCH).useValue(rawFetch);
  return (await builder.compile()).get(ZoomInfoService);
}

const summary = (value: unknown): void => console.log(JSON.stringify(value, null, 2));

// Only stable anchor; all other fixtures (IDs, people) are derived from live data so record changes don't break tests.
const ANCHOR_DOMAIN = 'microsoft.com';

async function anchorCompanyId(service: ZoomInfoService): Promise<string> {
  const result = await service.identifyCompany({ website: ANCHOR_DOMAIN });
  const company = result.match ?? result.candidates[0];
  expect(company).toBeDefined();
  return company.zoomInfoId;
}

describe.skipIf(!configured)('ZoomInfo live', { timeout: 60_000 }, () => {
  it('identifies a company by website', async () => {
    const result = await (await createService()).identifyCompany({ website: ANCHOR_DOMAIN });
    summary(result);
    expect(result.entityType).toBe('company');
    expect(['matched', 'ambiguous']).toContain(result.status);
    expect(result.candidates.length).toBeGreaterThan(0);
  });

  it('resolves a company by ZoomInfo ID', async () => {
    const service = await createService();
    const zoomInfoId = await anchorCompanyId(service);
    const result = await service.identifyCompany({ zoomInfoId });
    expect(result.status).toBe('matched');
    expect(result.matchBasis).toBe('zoominfo_id');
    expect(result.match?.zoomInfoId).toBe(zoomInfoId);
  });

  it('returns no_match for an unknown person', async () => {
    const service = await createService();
    const companyZoomInfoId = await anchorCompanyId(service);
    const result = await service.identifyPerson({ fullName: 'Zzyzx Qwvbnmxq', companyZoomInfoId });
    expect(result.entityType).toBe('person');
    expect(result.status).toBe('no_match');
  });

  describe.skipIf(!enrichEnabled)('enrich (consumes credits)', () => {
    it('enriches a company and one of its key people', async () => {
      const service = await createService();
      const zoomInfoId = await anchorCompanyId(service);
      const company = await service.enrichCompany({ zoomInfoId });
      summary(company);
      expect(company.status).toBe('matched');
      expect(company.profile?.zoomInfoId).toBe(zoomInfoId);
      expect(company.keyPeople.status).toBe('ok');

      const [keyPerson] = company.keyPeople.items;
      expect(keyPerson).toBeDefined();
      const identified = await service.identifyPerson({ fullName: keyPerson.name, companyZoomInfoId: zoomInfoId });
      expect(identified.candidates.map((c) => c.zoomInfoId)).toContain(keyPerson.zoomInfoId);

      const person = await service.enrichPerson({ zoomInfoId: keyPerson.zoomInfoId });
      summary(person);
      expect(person.status).toBe('matched');
      expect(person.profile?.zoomInfoId).toBe(keyPerson.zoomInfoId);
    });
  });
});
