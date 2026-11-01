import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZoomInfoClient } from './zoominfo.client.js';
import { loadZoomInfoConfig, type ZoomInfoConfig } from './zoominfo.config.js';
import { ZoomInfoError, type ZoomInfoErrorCode } from './zoominfo.errors.js';
import { ZoomInfoService } from './zoominfo.service.js';
import { ZoomInfoTokenProvider } from './zoominfo-token.provider.js';
import { ZoomInfoTransport } from './zoominfo.transport.js';

const CLIENT_SECRET = 'test-client-secret-value';

interface Call {
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
  json: { data?: { type?: string; attributes?: Record<string, unknown> } };
}

type Handler = (call: Call, signal: AbortSignal) => Response | Promise<Response>;

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/vnd.api+json', ...headers },
  });

const list = (data: unknown[], totalResults = data.length) => ({ data, meta: { totalResults, page: { number: 1 } } });

let tokenCounter = 0;
const tokenResponse = (expiresIn = 3600): Response =>
  json(200, { access_token: `tok-${++tokenCounter}`, expires_in: expiresIn, token_type: 'Bearer' });

const hang = (signal: AbortSignal): Promise<Response> =>
  new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason as Error)));

// Fixtures modelled on the GTM Data API responses
const OSF_DIGITAL = {
  id: '346572700',
  type: 'Company',
  attributes: { name: 'OSF Digital', website: 'www.osf.digital', city: 'Quebec', state: 'Quebec', country: 'Canada', employeeCount: '1000 - 5000', revenue: '$100 - 250 Million' },
};
const CONTOSO = {
  id: '20219826',
  type: 'Company',
  attributes: { name: 'Contoso Group N.V.', website: 'www.contoso.com', city: 'Amsterdam', country: 'Netherlands' },
};
const CONTOSO_HEALTH = {
  id: '20219827',
  type: 'Company',
  attributes: { name: 'Contoso Health', website: 'www.contoso.com', city: 'Philadelphia', country: 'United States' },
};
const CONTOSO_TAA = {
  id: '20219828',
  type: 'Company',
  attributes: { name: 'Contoso Tax & Accounting', website: 'www.contoso.com/en/solutions/tax-accounting', country: 'United States' },
};
const TEST_PERSON = {
  id: '4100000001',
  type: 'Contact',
  attributes: {
    firstName: 'Avery',
    lastName: 'Quill',
    jobTitle: 'Technical Architect',
    managementLevel: 'Manager',
    contactAccuracyScore: 95,
    company: { id: 346572700, name: 'OSF Digital' },
  },
};
const TEST_PERSON_NAMESAKE = {
  id: '5000000001',
  type: 'Contact',
  attributes: { firstName: 'Avery', lastName: 'Quill', jobTitle: 'Engineer', company: { id: 99, name: 'Another Co' } },
};

function setup(handler: Handler, overrides: Partial<ZoomInfoConfig> = {}) {
  const config: ZoomInfoConfig = {
    ...loadZoomInfoConfig({ ZOOMINFO_CLIENT_ID: 'test-client-id', ZOOMINFO_CLIENT_SECRET: CLIENT_SECRET, APP_VERSION: '1.2.3' }),
    retryBaseDelayMs: 1,
    ...overrides,
  };
  const calls: Call[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === 'string' ? init.body : '';
    const call: Call = {
      path: url.pathname.replace('/gtm', ''),
      query: url.searchParams,
      headers: init?.headers as Record<string, string>,
      body,
      json: url.pathname.endsWith('/token') ? {} : (JSON.parse(body) as Call['json']),
    };
    calls.push(call);
    return handler(call, init!.signal!);
  });
  const transport = new ZoomInfoTransport(config, fetchFn);
  const tokens = new ZoomInfoTokenProvider(config, transport);
  const service = new ZoomInfoService(config, new ZoomInfoClient(config, transport, tokens));
  const dataCalls = () => calls.filter((c) => c.path !== '/oauth/v1/token');
  const tokenCalls = () => calls.filter((c) => c.path === '/oauth/v1/token');
  return { service, calls, dataCalls, tokenCalls, transport };
}

/** Routes the token endpoint automatically and everything else to `data`. */
const withToken =
  (data: Handler): Handler =>
  (call, signal) =>
    call.path === '/oauth/v1/token' ? tokenResponse() : data(call, signal);

async function expectCode(promise: Promise<unknown>, code: ZoomInfoErrorCode): Promise<ZoomInfoError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ZoomInfoError);
  expect((error as ZoomInfoError).code).toBe(code);
  return error as ZoomInfoError;
}

let logs: string[];

beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'debug', 'error'] as const) {
    vi.spyOn(Logger.prototype, level).mockImplementation((message: unknown) => {
      logs.push(typeof message === 'string' ? message : JSON.stringify(message));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ZoomInfoService.identifyCompany', () => {
  it('matches OSF Digital as the single candidate and keeps source metadata', async () => {
    const { service, dataCalls, tokenCalls } = setup(withToken(() => json(200, list([OSF_DIGITAL]))));

    const result = await service.identifyCompany({ name: 'OSF Digital' });

    expect(result).toMatchObject({
      provider: 'zoominfo',
      entityType: 'company',
      status: 'matched',
      matchBasis: 'single_candidate',
      match: { zoomInfoId: '346572700', name: 'OSF Digital', website: 'www.osf.digital' },
      source: { sourceType: 'zoominfo', sourceReference: '346572700' },
      totalResults: 1,
    });
    expect(Date.parse(result.retrievedAt)).not.toBeNaN();

    const [call] = dataCalls();
    expect(call.path).toBe('/data/v1/companies/search');
    expect(call.query.get('page[size]')).toBe('10');
    expect(call.json).toEqual({ data: { type: 'CompanySearch', attributes: { companyName: 'OSF Digital' } } });
    expect(call.headers).toMatchObject({
      Authorization: 'Bearer tok-' + String(tokenCounter),
      'Content-Type': 'application/vnd.api+json',
      Accept: 'application/vnd.api+json',
      'User-Agent': 'taa-enrichment-api/1.2.3',
    });

    const [token] = tokenCalls();
    expect(token.headers).toMatchObject({
      Authorization: 'Basic ' + Buffer.from(`test-client-id:${CLIENT_SECRET}`).toString('base64'),
      'User-Agent': 'taa-enrichment-api/1.2.3',
    });
    expect(Object.fromEntries(new URLSearchParams(token.body))).toEqual({
      grant_type: 'client_credentials',
      scope: 'api:data:company api:data:contact api:data:news',
    });
  });

  it('narrows a name search, but not a website search, to the country', async () => {
    const { service, dataCalls } = setup(withToken(() => json(200, list([OSF_DIGITAL]))));

    await service.identifyCompany({ name: 'OSF', country: 'Canada' });
    await service.identifyCompany({ website: 'osf.digital', country: 'Canada' });

    const [byName, byWebsite] = dataCalls();
    expect(byName.json).toEqual({ data: { type: 'CompanySearch', attributes: { companyName: 'OSF', country: 'Canada' } } });
    expect(byWebsite.json).toEqual({ data: { type: 'CompanySearch', attributes: { companyWebsite: 'http://www.osf.digital' } } });
  });

  it('resolves Contoso by exact (suffix-insensitive) name among several candidates', async () => {
    const { service } = setup(
      withToken(() => json(200, list([CONTOSO_HEALTH, CONTOSO, CONTOSO_TAA], 42))),
    );

    const result = await service.identifyCompany({ name: 'Contoso Group' });

    expect(result).toMatchObject({ status: 'matched', matchBasis: 'exact_name', totalResults: 42 });
    expect(result.match?.zoomInfoId).toBe(CONTOSO.id);
    expect(result.candidates).toHaveLength(3);
  });

  it('never silently picks the first candidate when the website is shared', async () => {
    const { service, dataCalls } = setup(
      withToken(() => json(200, list([CONTOSO_HEALTH, CONTOSO, CONTOSO_TAA]))),
    );

    const result = await service.identifyCompany({ website: 'https://www.contoso.com/en' });

    expect(result).toMatchObject({ status: 'ambiguous', match: null, matchBasis: null });
    expect(result.source.sourceReference).toBeNull();
    expect(result.candidates.map((c) => c.zoomInfoId)).toEqual([
      CONTOSO_HEALTH.id,
      CONTOSO.id,
      CONTOSO_TAA.id,
    ]);
    expect(dataCalls()[0].json.data?.attributes).toEqual({ companyWebsite: 'http://www.contoso.com' });
  });

  it('uses the name to disambiguate candidates sharing a website', async () => {
    const { service } = setup(withToken(() => json(200, list([CONTOSO_HEALTH, CONTOSO]))));

    const result = await service.identifyCompany({ website: 'contoso.com', name: 'Contoso Health' });

    expect(result).toMatchObject({ status: 'matched', matchBasis: 'exact_name' });
    expect(result.match?.zoomInfoId).toBe(CONTOSO_HEALTH.id);
  });

  it('returns an explicit no_match for an empty successful search', async () => {
    const { service } = setup(withToken(() => json(200, list([]))));

    const result = await service.identifyCompany({ name: 'No Such Company 123' });

    expect(result).toMatchObject({ status: 'no_match', match: null, candidates: [], totalResults: 0 });
  });

  it('searches by ZoomInfo ID when provided', async () => {
    const { service, dataCalls } = setup(withToken(() => json(200, list([OSF_DIGITAL]))));

    const result = await service.identifyCompany({ zoomInfoId: '346572700', name: 'ignored' });

    expect(result).toMatchObject({ status: 'matched', matchBasis: 'zoominfo_id' });
    expect(dataCalls()[0].json.data?.attributes).toEqual({ companyId: '346572700' });
  });

  it('rejects empty or invalid input without calling ZoomInfo', async () => {
    const { service, calls } = setup(withToken(() => json(200, list([]))));

    await expectCode(service.identifyCompany({ name: '  ' }), 'invalid_request');
    await expectCode(service.identifyCompany({ zoomInfoId: 'abc' }), 'invalid_request');
    expect(calls).toHaveLength(0);
  });
});

describe('ZoomInfoService.identifyPerson', () => {
  it('matches a person at OSF Digital, separate from the company', async () => {
    const { service, dataCalls } = setup(withToken(() => json(200, list([TEST_PERSON]))));

    const result = await service.identifyPerson({ firstName: 'Avery', lastName: 'Quill', companyName: 'OSF Digital' });

    expect(result).toMatchObject({
      entityType: 'person',
      status: 'matched',
      matchBasis: 'single_candidate',
      source: { sourceType: 'zoominfo', sourceReference: '4100000001' },
      match: {
        zoomInfoId: '4100000001',
        firstName: 'Avery',
        lastName: 'Quill',
        managementLevel: ['Manager'],
        contactAccuracyScore: 95,
        company: { zoomInfoId: '346572700', name: 'OSF Digital' },
      },
    });
    const [call] = dataCalls();
    expect(call.path).toBe('/data/v1/contacts/search');
    expect(call.json).toEqual({
      data: { type: 'ContactSearch', attributes: { firstName: 'Avery', lastName: 'Quill', companyName: 'OSF Digital' } },
    });
  });

  it('disambiguates by name and company, otherwise returns candidates', async () => {
    const { service } = setup(withToken(() => json(200, list([TEST_PERSON_NAMESAKE, TEST_PERSON]))));

    const scoped = await service.identifyPerson({ fullName: 'Avery Quill', companyName: 'OSF Digital Inc.' });
    expect(scoped).toMatchObject({ status: 'matched', matchBasis: 'exact_name' });
    expect(scoped.match?.zoomInfoId).toBe(TEST_PERSON.id);

    const unscoped = await service.identifyPerson({ fullName: 'Avery Quill' });
    expect(unscoped).toMatchObject({ status: 'ambiguous', match: null });
    expect(unscoped.candidates).toHaveLength(2);
  });
});

describe('ZoomInfoService.enrichCompany', () => {
  const companyEnrich = {
    data: [
      {
        id: '346572700',
        type: 'Company',
        attributes: {
          name: 'OSF Digital',
          website: 'www.osf.digital',
          domainList: ['osf.digital', 'osf-global.com'],
          employeeCount: 3000,
          revenue: 150000,
          products: ['Salesforce Commerce Cloud implementation'],
          sicCodes: [{ id: '7371', name: 'Computer Programming Services' }],
          socialMediaUrls: [{ type: 'LINKED_IN', url: 'https://www.linkedin.com/company/osf-digital' }],
          ultimateParentId: 346572700,
          ultimateParentName: 'OSF Digital',
          ultimateParentRevenue: 150000,
          parentId: 0,
          type: 'PRIVATE',
          primaryIndustryCode: { id: 'bizservice', name: 'Business Services' },
          employeeGrowth: { oneYearGrowthRate: '-3.8', employeeGrowthDataPoints: [{ label: "'26-Q2", employeeCount: 2900 }] },
          departmentBudgets: { itBudget: 19839, marketingBudget: 'n/a' },
          totalFundingAmount: 140306,
          companyFunding: [
            { amount: 40306, date: '2021-05-12T07:00:00.000Z', investors: ['Salesforce Ventures'], type: 'Series B' },
            { amount: 100000, date: '2022-04-13T07:00:00.000Z', investors: ['Sunstone Partners'], type: 'Series C' },
          ],
          competitors: [
            { id: 2, name: 'Second', rank: 2 },
            { id: 1, name: 'First', rank: 1, website: 'first.example', employeeCount: 180 },
            { id: 0, rank: 3 },
          ],
        },
        meta: { matchStatus: 'FULL_MATCH', input: { companyId: 346572700 } },
      },
    ],
  };
  const technologies = list([
    { id: '11', type: 'Technology', attributes: { product: 'Salesforce Sales Cloud', vendor: 'Salesforce', category: 'CRM' } },
  ]);
  const executives = list([
    { id: '77', type: 'Contact', attributes: { firstName: 'Morgan', lastName: 'Reyes', jobTitle: 'CEO', managementLevel: ['C-Level'] } },
  ]);
  const news = list([
    { id: 'n1', type: 'News', attributes: { title: 'Older', url: 'https://example.com/1', pageDate: '2026-01-01', categories: ['partnerships'] } },
    { id: 'n2', type: 'News', attributes: { title: 'Newer', url: 'https://example.com/2', pageDate: '2026-06-01' } },
  ]);

  const route =
    (overrides: Partial<Record<string, Handler>> = {}): Handler =>
    (call, signal) => {
      const handler = overrides[call.path];
      if (handler) return handler(call, signal);
      switch (call.path) {
        case '/oauth/v1/token':
          return tokenResponse();
        case '/data/v1/companies/enrich':
          return json(200, companyEnrich);
        case '/data/v1/companies/technologies/enrich':
          return json(200, technologies);
        case '/data/v1/contacts/search':
          return json(200, executives);
        case '/data/v1/news/enrich':
          return json(200, news);
        default:
          return json(404, {});
      }
    };

  it('returns profile, technologies, key people and news with source metadata', async () => {
    const { service, dataCalls, tokenCalls } = setup(route());

    const result = await service.enrichCompany({ zoomInfoId: '346572700' });

    expect(result).toMatchObject({
      provider: 'zoominfo',
      entityType: 'company',
      status: 'matched',
      matchStatus: 'FULL_MATCH',
      completeness: 'complete',
      warnings: [],
      source: { sourceType: 'zoominfo', sourceReference: '346572700' },
      profile: {
        zoomInfoId: '346572700',
        name: 'OSF Digital',
        headcount: 3000,
        revenueThousandsUsd: 150000,
        domains: ['osf.digital', 'osf-global.com'],
        productsAndServices: ['Salesforce Commerce Cloud implementation'],
        sicCodes: [{ id: '7371', name: 'Computer Programming Services' }],
        ultimateParent: { zoomInfoId: '346572700', name: 'OSF Digital', revenueThousandsUsd: 150000 },
        parent: null,
        ownershipType: 'private',
        primaryIndustryCodes: [{ id: 'bizservice', name: 'Business Services' }],
        employeeGrowth: { oneYearRate: '-3.8', quarterly: [{ label: "'26-Q2", headcount: 2900 }] },
        departmentBudgets: { itBudget: 19839 },
        funding: {
          totalThousandsUsd: 140306,
          rounds: [
            { type: 'Series C', amountThousandsUsd: 100000, investors: ['Sunstone Partners'] },
            { type: 'Series B', amountThousandsUsd: 40306 },
          ],
        },
        competitors: [
          { zoomInfoId: '1', name: 'First', rank: 1, website: 'first.example', headcount: 180 },
          { zoomInfoId: '2', name: 'Second', rank: 2 },
        ],
      },
      technologies: { status: 'ok', items: [{ zoomInfoId: '11', product: 'Salesforce Sales Cloud', vendor: 'Salesforce' }] },
      keyPeople: { status: 'ok', items: [{ zoomInfoId: '77', name: 'Morgan Reyes', jobTitle: 'CEO' }] },
      news: { status: 'ok', items: [{ title: 'Newer' }, { title: 'Older', categories: ['partnerships'] }] },
    });
    expect(tokenCalls()).toHaveLength(1);

    const byPath = Object.fromEntries(dataCalls().map((c) => [c.path, c]));
    expect(byPath['/data/v1/companies/enrich'].json.data).toMatchObject({
      type: 'CompanyEnrich',
      attributes: { matchCompanyInput: [{ companyId: 346572700 }], outputFields: expect.arrayContaining(['name', 'employeeCount']) as unknown },
    });
    expect(byPath['/data/v1/contacts/search'].json.data?.attributes).toEqual({ companyId: '346572700', executivesOnly: true });
    expect(byPath['/data/v1/news/enrich'].json.data?.attributes).toMatchObject({ companyId: 346572700 });
  });

  it('returns a partial result with a warning when a signal source is not licensed', async () => {
    const { service } = setup(
      route({ '/data/v1/news/enrich': () => json(403, { errors: [{ code: 'ZI0002', status: '403' }] }) }),
    );

    const result = await service.enrichCompany({ zoomInfoId: '346572700' });

    expect(result).toMatchObject({
      status: 'matched',
      completeness: 'partial',
      warnings: [{ section: 'news', code: 'entitlement_missing' }],
      news: { status: 'failed', error: 'entitlement_missing', items: [] },
      technologies: { status: 'ok' },
    });
    expect(result.profile?.name).toBe('OSF Digital');
  });

  it('skips optional sections on request', async () => {
    const { service, dataCalls } = setup(route());

    const result = await service.enrichCompany(
      { zoomInfoId: '346572700' },
      { include: { technologies: false, keyPeople: false, news: false } },
    );

    expect(result.completeness).toBe('complete');
    expect(result.news.status).toBe('skipped');
    expect(dataCalls().map((c) => c.path)).toEqual(['/data/v1/companies/enrich']);
  });

  it('reports no_match explicitly and skips signal sections', async () => {
    const { service } = setup(
      route({
        '/data/v1/companies/enrich': () =>
          json(200, { data: [{ id: '0', type: 'NoMatch', meta: { matchStatus: 'NO_MATCH', input: { companyId: 1 } } }] }),
      }),
    );

    const result = await service.enrichCompany({ zoomInfoId: '1' });

    expect(result).toMatchObject({
      status: 'no_match',
      matchStatus: 'NO_MATCH',
      profile: null,
      source: { sourceReference: null },
      technologies: { status: 'skipped' },
      news: { status: 'skipped' },
    });
  });

  it('fails the operation when the profile fails and cancels signal branches', async () => {
    const aborted: string[] = [];
    const { service } = setup(
      route({
        '/data/v1/companies/enrich': () => json(500, {}),
        '/data/v1/news/enrich': (call, signal) => {
          signal.addEventListener('abort', () => aborted.push(call.path));
          return hang(signal);
        },
      }),
    );

    await expectCode(service.enrichCompany({ zoomInfoId: '346572700' }), 'upstream_unavailable');
    expect(aborted).toEqual(['/data/v1/news/enrich']);
  });

  it('maps LIMIT_EXCEEDED to quota_exceeded', async () => {
    const { service } = setup(
      route({
        '/data/v1/companies/enrich': () =>
          json(200, { data: [{ id: '0', type: 'NoMatch', meta: { matchStatus: 'LIMIT_EXCEEDED', input: {} } }] }),
      }),
    );

    await expectCode(service.enrichCompany({ zoomInfoId: '346572700' }), 'quota_exceeded');
  });
});

describe('ZoomInfoService.enrichPerson', () => {
  it('enriches a person by ID', async () => {
    const { service, dataCalls } = setup(
      withToken(() =>
        json(200, {
          data: [
            {
              id: '4100000001',
              type: 'Contact',
              attributes: {
                firstName: 'Avery',
                lastName: 'Quill',
                jobTitle: 'Technical Architect',
                jobFunction: [{ name: 'Engineering', department: 'Engineering & Technical' }],
                managementLevel: ['Manager'],
                contactAccuracyScore: '95',
                externalUrls: [{ type: 'linkedin.com', url: 'https://www.linkedin.com/in/example' }],
                employmentHistory: [{ jobTitle: 'Architect', fromDate: '2020-01-01', company: { companyId: 346572700, companyName: 'OSF Digital' } }],
                email: 'avery@example.com',
                mobilePhoneDoNotCall: true,
                withinCanada: false,
                company: { id: 346572700, name: 'OSF Digital', website: 'www.osf.digital', type: 'PRIVATE', revenueNumeric: 536201000 },
              },
              meta: { matchStatus: 'FULL_MATCH', input: { personId: 4100000001 } },
            },
          ],
        }),
      ),
    );

    const result = await service.enrichPerson({ zoomInfoId: '4100000001' });

    expect(result).toMatchObject({
      entityType: 'person',
      status: 'matched',
      source: { sourceType: 'zoominfo', sourceReference: '4100000001' },
      profile: {
        zoomInfoId: '4100000001',
        jobTitle: 'Technical Architect',
        jobFunctions: [{ name: 'Engineering', department: 'Engineering & Technical' }],
        contactAccuracyScore: 95,
        employmentHistory: [{ company: { zoomInfoId: '346572700', name: 'OSF Digital' } }],
        email: 'avery@example.com',
        doNotCall: { mobilePhone: true },
        jurisdiction: { withinCanada: false },
        company: { zoomInfoId: '346572700', name: 'OSF Digital', ownershipType: 'private', revenueUsd: 536201000 },
      },
    });
    const attributes = dataCalls()[0].json.data?.attributes as { outputFields: string[]; matchPersonInput: unknown };
    expect(attributes.matchPersonInput).toEqual([{ personId: 4100000001 }]);
    expect(attributes.outputFields).toEqual(expect.arrayContaining(['email', 'mobilePhone', 'companyRevenueNumeric']));
  });

  it('does not present a company-only match as the person', async () => {
    const { service } = setup(
      withToken(() =>
        json(200, {
          data: [{ id: '1', type: 'Contact', attributes: { company: { id: 1 } }, meta: { matchStatus: 'COMPANY_ONLY_MATCH', input: {} } }],
        }),
      ),
    );

    const result = await service.enrichPerson({ zoomInfoId: '1' });

    expect(result).toMatchObject({ status: 'no_match', matchStatus: 'COMPANY_ONLY_MATCH', profile: null });
  });
});

describe('ZoomInfo error handling', () => {
  it.each([
    [400, 'PFAPI0003', 'invalid_request'],
    [400, 'PFAPI0011', 'quota_exceeded'],
    [403, 'ZI0003', 'entitlement_missing'],
  ] as const)('maps %i %s to %s without retrying', async (status, upstreamCode, code) => {
    const { service, dataCalls } = setup(withToken(() => json(status, { errors: [{ code: upstreamCode }] })));

    const error = await expectCode(service.identifyCompany({ name: 'OSF Digital' }), code);
    expect(error.details).toMatchObject({ status, upstreamCode });
    expect(dataCalls()).toHaveLength(1);
  });

  it('clears a rejected cached token and retries once with a new one', async () => {
    let rejectNext = false;
    const { service, tokenCalls, dataCalls } = setup(
      withToken((call) => {
        if (rejectNext && call.headers.Authorization === 'Bearer tok-' + String(tokenCounter)) {
          rejectNext = false;
          return json(401, { errors: [{ code: 'ZI0001' }] });
        }
        return json(200, list([OSF_DIGITAL]));
      }),
    );

    await service.identifyCompany({ name: 'OSF Digital' });
    rejectNext = true;
    const result = await service.identifyCompany({ name: 'OSF Digital' });

    expect(result.status).toBe('matched');
    expect(tokenCalls()).toHaveLength(2);
    expect(dataCalls()).toHaveLength(3);
  });

  it('fails with auth_failed when a freshly issued token is rejected', async () => {
    const { service, tokenCalls } = setup(withToken(() => json(401, { errors: [{ code: 'ZI0001' }] })));

    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'auth_failed');
    expect(tokenCalls()).toHaveLength(1);
  });

  it('maps token endpoint rejection to auth_failed and never leaks credentials', async () => {
    const { service, calls } = setup(() => json(401, { error: 'invalid_client', error_description: CLIENT_SECRET }));

    const error = await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'auth_failed');

    expect(calls).toHaveLength(1);
    expect(error.message).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify(error)).not.toContain(CLIENT_SECRET);
    expect(logs.join('\n')).not.toContain(CLIENT_SECRET);
  });

  it('never logs tokens, request bodies or person inputs', async () => {
    const { service } = setup(withToken(() => json(500, {})));

    await expectCode(service.identifyPerson({ fullName: 'Avery Quill', companyName: 'OSF Digital' }), 'upstream_unavailable');

    const output = logs.join('\n');
    expect(output).toContain('zoominfo.request_failed');
    expect(output).not.toMatch(/tok-\d+|Quill|OSF Digital|Bearer|test-client-id/);
  });

  it('caches the token across calls and refreshes it once expired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, tokenCalls } = setup(withToken(() => json(200, list([OSF_DIGITAL]))));

    await service.identifyCompany({ name: 'OSF Digital' });
    await service.identifyCompany({ name: 'OSF Digital' });
    expect(tokenCalls()).toHaveLength(1);

    vi.setSystemTime(Date.now() + 3_600_000);
    await service.identifyCompany({ name: 'OSF Digital' });
    expect(tokenCalls()).toHaveLength(2);
  });

  it('requests a single token for concurrent calls', async () => {
    const { service, tokenCalls } = setup(
      withToken((call) => json(200, list([call.path.includes('contacts') ? TEST_PERSON : OSF_DIGITAL]))),
    );

    await Promise.all([
      service.identifyCompany({ name: 'OSF Digital' }),
      service.identifyCompany({ name: 'Contoso Group' }),
      service.identifyPerson({ fullName: 'Avery Quill' }),
    ]);

    expect(tokenCalls()).toHaveLength(1);
  });

  it('retries a 5xx once by default and then fails as upstream_unavailable', async () => {
    const { service, dataCalls } = setup(withToken(() => json(503, {})));

    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'upstream_unavailable');
    expect(dataCalls()).toHaveLength(2);
  });

  it('honours the configured retry count per call type', async () => {
    const { service, dataCalls } = setup(withToken(() => json(503, {})), {
      retries: { token: 1, search: 0, enrich: 1, signals: 1 },
    });

    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'upstream_unavailable');
    expect(dataCalls()).toHaveLength(1);
  });

  it('treats network failures as upstream_unavailable', async () => {
    const { service } = setup(
      withToken(() => {
        throw new TypeError('fetch failed');
      }),
    );

    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'upstream_unavailable');
  });

  it('retries a 429 after a Retry-After that fits the budget', async () => {
    let limited = true;
    const { service, dataCalls } = setup(
      withToken(() => {
        if (!limited) return json(200, list([OSF_DIGITAL]));
        limited = false;
        return json(429, { errors: [{ code: 'ZI0004' }] }, { 'Retry-After': '0', 'X-RateLimit-Rejected-Bucket': 'second' });
      }),
    );

    const result = await service.identifyCompany({ name: 'OSF Digital' });

    expect(result.status).toBe('matched');
    expect(dataCalls()).toHaveLength(2);
  });

  it('enters a provider-wide cooldown when Retry-After exceeds the budget', async () => {
    const { service, dataCalls, transport } = setup(
      withToken(() => json(429, { errors: [{ code: 'ZI0004' }] }, { 'Retry-After': '719', 'X-RateLimit-Rejected-Bucket': 'hour' })),
    );

    const error = await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'rate_limited');
    expect(error.details.retryAfterMs).toBe(719_000);
    expect(dataCalls()).toHaveLength(1);
    expect(transport.cooldownRemainingMs()).toBeGreaterThan(700_000);

    await expectCode(service.identifyPerson({ fullName: 'Avery Quill' }), 'rate_limited');
    expect(dataCalls()).toHaveLength(1);
    expect(logs.join('\n')).toContain('"bucket":"hour"');
  });

  it('times out within the lookup budget', async () => {
    const { service } = setup(withToken((_call, signal) => hang(signal)), { lookupBudgetMs: 50 });

    const started = Date.now();
    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('caps the budget by the caller deadline', async () => {
    const { service } = setup(withToken((_call, signal) => hang(signal)));

    const started = Date.now();
    await expectCode(service.identifyCompany({ name: 'OSF Digital' }, { deadline: Date.now() + 50 }), 'timeout');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops waiting when the caller cancels', async () => {
    const { service } = setup(withToken((_call, signal) => hang(signal)));
    const controller = new AbortController();

    const pending = service.identifyCompany({ name: 'OSF Digital' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);

    await expectCode(pending, 'cancelled');
  });

  it('rejects malformed JSON and unexpected shapes at the adapter boundary', async () => {
    const bodies = ['<html>not json</html>', { data: 'nope' }, { data: [{ id: '1', type: 'Company' }] }, list([TEST_PERSON])];
    for (const body of bodies) {
      const { service } = setup(withToken(() => json(200, body)));
      await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'malformed_response');
    }

    const { service } = setup(() => json(200, { token_type: 'Bearer' }));
    await expectCode(service.identifyCompany({ name: 'OSF Digital' }), 'malformed_response');
  });

  it('fails fast without network calls when disabled or not configured', async () => {
    const disabled = setup(withToken(() => json(200, list([]))), { enabled: false });
    await expectCode(disabled.service.identifyCompany({ name: 'OSF Digital' }), 'disabled');
    expect(disabled.calls).toHaveLength(0);
    expect(disabled.service.isAvailable()).toBe(false);

    const missing = setup(withToken(() => json(200, list([]))), { credentials: null });
    await expectCode(missing.service.enrichCompany({ zoomInfoId: '1' }), 'not_configured');
    expect(missing.calls).toHaveLength(0);
  });
});

describe('loadZoomInfoConfig', () => {
  it('reads overrides', () => {
    const config = loadZoomInfoConfig({
      ZOOMINFO_ENABLED: 'false',
      ZOOMINFO_BASE_URL: 'https://example.test/gtm/',
      ZOOMINFO_USER_AGENT: 'custom/1',
      ZOOMINFO_RETRIES_ENRICH: '0',
      ZOOMINFO_COMPANY_FIELDS: 'id, name',
      ZOOMINFO_SCOPES: 'api:data:company, api:data:contact',
    });

    expect(config).toMatchObject({
      enabled: false,
      baseUrl: 'https://example.test/gtm',
      userAgent: 'custom/1',
      retries: { enrich: 0, search: 1 },
      companyOutputFields: ['id', 'name'],
      scopes: ['api:data:company', 'api:data:contact'],
    });
  });

  it('rejects invalid values', () => {
    expect(() => loadZoomInfoConfig({ ZOOMINFO_BASE_URL: 'http://api.zoominfo.com' })).toThrow(/https/);
    expect(() => loadZoomInfoConfig({ ZOOMINFO_RETRIES_SEARCH: '-1' })).toThrow(/ZOOMINFO_RETRIES_SEARCH/);
    expect(() => loadZoomInfoConfig({ ZOOMINFO_ENABLED: 'maybe' })).toThrow(/ZOOMINFO_ENABLED/);
    expect(() => loadZoomInfoConfig({ ZOOMINFO_CONTACT_FIELDS: 'email;phone' })).toThrow(/ZOOMINFO_CONTACT_FIELDS/);
    expect(() => loadZoomInfoConfig({ ZOOMINFO_SCOPES: 'data:company' })).toThrow(/ZOOMINFO_SCOPES/);
  });
});
