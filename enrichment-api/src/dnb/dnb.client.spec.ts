import { describe, expect, it } from 'vitest';
import { DnbClient } from './dnb.client.js';
import { loadDnbConfig } from './dnb.config.js';
import { DnbError } from './dnb.errors.js';

const DUNS = '081466849';

/** Trimmed from a real matchEnrich response for Microsoft (public company data). */
function matchEnrichBody(confidenceCode = 10): Record<string, unknown> {
  return {
    matchStatus: 'success',
    matchCandidates: [
      {
        organization: { duns: DUNS, primaryName: 'Microsoft Corporation' },
        matchQualityInformation: { confidenceCode, matchGrade: 'AAAAAAAAAAA', nameMatchScore: 100 },
      },
    ],
    embeddedProduct: {
      organization: {
        duns: DUNS,
        primaryName: 'Microsoft Corporation',
        websiteAddress: [{ url: 'www.microsoft.com' }],
        telephone: [{ telephoneNumber: '4258828080', isdCode: '1' }],
        primaryAddress: {
          addressCountry: { isoAlpha2Code: 'US' },
          addressLocality: { name: 'Redmond' },
          addressRegion: { name: 'Washington', abbreviatedName: 'WA' },
          streetAddress: { line1: '1 Microsoft Way', line2: null },
          postalCode: '98052-6399',
        },
        industryCodes: [
          { code: '541511', description: 'Custom Computer Programming Services', typeDescription: 'North American Industry Classification System 2022', priority: 1 },
          { code: '1001', description: 'Software', typeDescription: 'D&B Hoovers Industry Classification', priority: 1 },
        ],
        numberOfEmployees: [
          { value: 1000, informationScopeDescription: 'Individual', reliabilityDescription: 'Modelled' },
          { value: 228000, informationScopeDescription: 'Consolidated', reliabilityDescription: 'Actual' },
        ],
        corporateLinkage: { globalUltimate: { duns: DUNS }, domesticUltimate: { duns: DUNS } },
        globalUltimate: { financials: [{ yearlyRevenue: [{ value: 245122000000, currency: 'USD' }], reliabilityDescription: 'Actual' }] },
      },
    },
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

interface Call {
  url: string;
  authorization: string;
}

function client(respond: (call: Call, index: number) => Response) {
  const calls: Call[] = [];
  const fetchFn = ((input: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call = { url: input, authorization: headers.get('authorization') ?? '' };
    calls.push(call);
    return Promise.resolve(respond(call, calls.length - 1));
  }) as typeof fetch;
  const config = loadDnbConfig({ DNB_CLIENT_ID: 'id', DNB_CLIENT_SECRET: 'secret' });
  return { dnb: new DnbClient(config, fetchFn), calls };
}

function tokenOr(response: (call: Call) => Response, token = 'token-1') {
  return (call: Call) => (call.url.endsWith('/v2/token') ? json(200, { access_token: token, expiresIn: 86400 }) : response(call));
}

const options = () => ({ deadline: Date.now() + 5000, signal: new AbortController().signal, correlationId: 'test' });

describe('DnbClient', () => {
  it('matches and parses the best candidate with its data', async () => {
    const { dnb, calls } = client(tokenOr(() => json(200, matchEnrichBody(6))));

    const result = await dnb.matchEnrich({ name: 'Microsoft', url: 'microsoft.com', country: 'US' }, options());

    expect(calls[0].authorization).toBe(`Basic ${Buffer.from('id:secret').toString('base64')}`);
    expect(calls[1].url).toBe('https://plus.dnb.com/v1/connect/matchEnrich/v2/Source_3d5hz4ae?name=Microsoft&url=microsoft.com&country=US');
    expect(calls[1].authorization).toBe('Bearer token-1');
    expect(result.candidate).toEqual({ duns: DUNS, name: 'Microsoft Corporation', confidenceCode: 6 });
    expect(result.organization).toEqual({
      duns: DUNS,
      name: 'Microsoft Corporation',
      website: 'www.microsoft.com',
      phone: '+1 4258828080',
      address: { street: '1 Microsoft Way', city: 'Redmond', region: 'Washington', postalCode: '98052-6399', countryCode: 'US' },
      industry: 'Software',
      headcount: { value: 228000, reliability: 'Actual' },
      revenueUsd: { value: 245122000000, reliability: 'Actual' },
    });
  });

  it('returns no candidate when D&B finds no match', async () => {
    const { dnb } = client(tokenOr(() => json(200, { matchStatus: 'no_match', matchCandidates: [] })));

    await expect(dnb.matchEnrich({ duns: DUNS }, options())).resolves.toEqual({ candidate: null, candidateCount: 0, organization: null });
  });

  it('reuses the token, and replaces it once when D&B rejects it', async () => {
    let tokens = 0;
    const { dnb, calls } = client((call) => {
      if (call.url.endsWith('/v2/token')) return json(200, { access_token: `token-${++tokens}`, expiresIn: 86400 });
      return call.authorization === 'Bearer token-1' && calls.length > 3 ? json(401, { error: { errorCode: '00004' } }) : json(200, matchEnrichBody());
    });

    await dnb.matchEnrich({ duns: DUNS }, options());
    await dnb.matchEnrich({ duns: DUNS }, options());
    await dnb.matchEnrich({ duns: DUNS }, options());

    expect(calls.map((c) => (c.url.endsWith('/v2/token') ? 'token' : c.authorization))).toEqual([
      'token',
      'Bearer token-1',
      'Bearer token-1',
      'Bearer token-1',
      'token',
      'Bearer token-2',
    ]);
  });

  it.each([
    [400, 'invalid_request'],
    [403, 'entitlement_missing'],
    [503, 'upstream_unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { dnb } = client(tokenOr(() => json(status, { error: { errorCode: 'CONNECT_001', errorMessage: 'bad' } })));

    const error = await dnb.matchEnrich({ name: 'Acme' }, options()).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DnbError);
    expect(error).toMatchObject({ code, details: { status, upstreamCode: 'CONNECT_001' } });
  });

  it('reports the retry hint when rate limited', async () => {
    const { dnb } = client(tokenOr(() => json(429, {}, { 'retry-after': '3' })));

    await expect(dnb.matchEnrich({ duns: DUNS }, options())).rejects.toMatchObject({ code: 'rate_limited', details: { retryAfterMs: 3000 } });
  });

  it('fails with auth_failed when the credentials are rejected', async () => {
    const { dnb, calls } = client(() => json(401, { error: { errorCode: '00004' } }));

    await expect(dnb.matchEnrich({ duns: DUNS }, options())).rejects.toMatchObject({ code: 'auth_failed', details: { operation: 'token' } });
    expect(calls).toHaveLength(1);
  });

  it('pings without credits: unauthenticated 401 means reachable, then the token proves the credentials', async () => {
    const { dnb, calls } = client((call) =>
      call.authorization ? json(200, { access_token: 'token-1', expiresIn: 86400 }) : json(401, {}),
    );

    await dnb.ping({ deadline: Date.now() + 5000 });
    await dnb.ping({ deadline: Date.now() + 5000 });

    expect(calls.map((c) => c.authorization.split(' ')[0] || 'none')).toEqual(['none', 'Basic', 'none']);
  });

  it('ping fails when D&B is down', async () => {
    const { dnb } = client(() => json(503, {}));

    await expect(dnb.ping({ deadline: Date.now() + 5000 })).rejects.toMatchObject({ code: 'upstream_unavailable' });
  });

  it('is unavailable without credentials', () => {
    const dnb = new DnbClient(loadDnbConfig({}), fetch);
    expect(dnb.isAvailable()).toBe(false);
  });
});
