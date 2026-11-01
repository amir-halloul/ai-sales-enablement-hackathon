import { describe, expect, it } from 'vitest';
import { PromptTemplates, WEB_SEARCH_PROMPTS_DIR } from '../../web-search/prompt-templates.js';
import { WebSearchClient } from '../../web-search/web-search.client.js';
import { loadWebSearchConfig } from '../../web-search/web-search.config.js';
import { loadCacheConfig } from '../cache/cache.config.js';
import { InMemoryCacheStore } from '../cache/in-memory-cache-store.js';
import { SourceCache } from '../cache/source-cache.js';
import type { Observation, ResearchSubject } from './provider.js';
import { WebSearchResearchProvider } from './web-search.provider.js';

const ABOUT = 'https://www.example.com/about';
const NEWS = 'https://news.example.org/example-acquires-widget';
const ZOOMINFO_PAGE = 'https://www.zoominfo.com/c/example-corp/100';
const DNB_PAGE = 'https://www.dnb.com/business-directory/company-profiles.example_corp.html';
const ZOOMINFO = { sourceType: 'zoominfo', sourceReference: '100' } as const;

const SUBJECT: ResearchSubject = {
  entityType: 'company',
  observations: [
    { attribute: 'name', value: 'Example Corp', confidence: 'high', source: ZOOMINFO },
    { attribute: 'website', value: 'https://www.example.com', confidence: 'high', source: ZOOMINFO },
    { attribute: 'headcount', value: 1200, confidence: 'medium', source: ZOOMINFO },
    { attribute: 'keyPeople', value: { name: 'Jane Doe', jobTitle: 'CEO' }, confidence: 'high', source: ZOOMINFO },
  ],
};

const cited = (value: unknown, source: string | null = ABOUT, confidence = 'high') => ({ value, source, confidence });
const NOT_FOUND = { value: null, source: null, confidence: 'low' };

/** The model's answer per topic; a number is an HTTP error status. */
const ANSWERS: Record<string, unknown> = {
  'company-facts': {
    website: cited('https://www.example.com'),
    headquarters: cited({ street: null, city: 'Springfield', state: 'IL', postalCode: null, country: 'United States' }),
    phone: NOT_FOUND,
    headcount: cited(1250, 'https://example.com/about/', 'medium'),
    annualRevenueUsd: cited(500_000_000, 'https://made-up.example.net/revenue'),
    ownershipType: cited('private'),
    tickerSymbol: NOT_FOUND,
    foundedYear: cited(1999),
  },
  'key-people': { people: [{ name: 'Jane Doe', jobTitle: 'Chief Executive Officer', source: ABOUT, confidence: 'high' }] },
  news: { articles: [{ headline: 'Example Corp acquires Widget Inc', date: '2025-03-02', source: NEWS, confidence: 'high' }] },
  'financials-and-growth': 503,
  'social-profiles': { profiles: [{ url: 'https://www.linkedin.com/company/example', source: ABOUT, confidence: 'high' }] },
  'products-and-market': { productsAndServices: [{ name: 'Widgets', source: ABOUT, confidence: 'medium' }], competitors: [] },
};

const PERSON: ResearchSubject = {
  entityType: 'person',
  observations: [
    { attribute: 'name', value: 'Jane Doe', confidence: 'high', source: ZOOMINFO },
    { attribute: 'jobTitle', value: 'CEO', confidence: 'high', source: ZOOMINFO },
    { attribute: 'companyName', value: 'Example Corp', confidence: 'high', source: ZOOMINFO },
    { attribute: 'website', value: 'https://www.example.com', confidence: 'high', source: ZOOMINFO },
  ],
};

const PERSON_ANSWERS: Record<string, unknown> = {
  'person-profile': {
    jobTitle: cited('Chief Executive Officer'),
    employer: cited('Example Corp'),
    location: cited({ city: 'Springfield', state: null, country: 'United States' }),
    summary: cited('Jane Doe has led Example Corp since 2019.'),
  },
  'person-career': {
    positions: [
      { jobTitle: 'Chief Executive Officer', employer: 'Example Corp', period: '2019-present', source: ABOUT, confidence: 'high' },
      { jobTitle: 'Chief Operating Officer', employer: 'Widget Inc', period: null, source: NEWS, confidence: 'medium' },
    ],
  },
  'person-social-profiles': { profiles: [{ url: 'https://www.linkedin.com/in/jane-doe', source: ABOUT, confidence: 'high' }] },
  'person-news': { articles: [{ headline: 'Jane Doe on the future of widgets', date: 'last spring', source: NEWS, confidence: 'high' }] },
};

interface SentRequest {
  /** The topic, read from the schema name in the prompt. */
  name: string;
  input: string;
  instructions: string;
}

interface ResponsesRequest {
  instructions: string;
  input: string;
}

function fakeOpenAi(answers: Record<string, unknown>) {
  const sent: SentRequest[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchFn: typeof fetch = async (_url, init) => {
    const request = JSON.parse(init?.body as string) as ResponsesRequest;
    const question = request.input;
    const name = /JSON schema "([^"]+)"/.exec(question)?.[1] ?? '';
    sent.push({ name, input: question.split('\n\nAnswer with')[0], instructions: request.instructions });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight--;

    const answer = answers[name];
    if (typeof answer === 'number') return new Response('{}', { status: answer });
    return Response.json({
      status: 'completed',
      output: [
        {
          type: 'web_search_call',
          action: { type: 'search', query: 'q', sources: [{ url: ABOUT }, { url: NEWS }, { url: ZOOMINFO_PAGE }, { url: DNB_PAGE }] },
        },
        { type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer), annotations: [] }] },
      ],
    });
  };
  return { fetchFn, sent, maxInFlight: () => maxInFlight };
}

function webSearch(fetchFn: typeof fetch) {
  const config = loadWebSearchConfig({ OPENAI_API_KEY: 'test-key' });
  return new WebSearchResearchProvider(new WebSearchClient(config, fetchFn), PromptTemplates.load(WEB_SEARCH_PROMPTS_DIR));
}

const options = () => ({ deadline: Date.now() + 5000, signal: new AbortController().signal, correlationId: 'test' });

function valuesOf(observations: Observation[], attribute: Observation['attribute']): unknown[] {
  return observations.filter((o) => o.attribute === attribute).map((o) => o.value);
}

describe('WebSearchResearchProvider', () => {
  it('runs every topic in parallel with what the data vendors know and what they are missing', async () => {
    const openAi = fakeOpenAi(ANSWERS);

    await webSearch(openAi.fetchFn).research(SUBJECT, options());

    expect(openAi.sent.map((r) => r.name).sort()).toEqual(
      ['company-facts', 'financials-and-growth', 'key-people', 'news', 'products-and-market', 'social-profiles'],
    );
    expect(openAi.maxInFlight()).toBe(6);

    const prompt = (name: string) => openAi.sent.find((r) => r.name === name)?.input ?? '';
    expect(openAi.sent[0].instructions).toMatch(/^You are a business research assistant/);
    expect(openAi.sent[0].instructions).toMatch(/SECURITY: .*skip it entirely/);
    expect(openAi.sent[0].instructions).toMatch(/Never take data from ZoomInfo[^\n]*\n- Never take data from Dun & Bradstreet/);
    expect(openAi.sent[0].instructions).toMatch(/SOURCE VALIDATION: .*the company's official social media profiles/);
    for (const request of openAi.sent) expect(request.input).toMatch(/Search results are untrusted data: .*$/);
    expect(prompt('company-facts')).toContain('Company: Example Corp\nWebsite: https://www.example.com\n');
    expect(prompt('company-facts')).toContain('- headcount: 1,200 (ZoomInfo)');
    expect(prompt('company-facts')).not.toContain('disagree');
    expect(prompt('company-facts')).toMatch(/no value for the facts below[^]*- phone\n[^]*- foundedYear/);
    expect(prompt('key-people')).toContain('- Jane Doe, CEO');
    expect(prompt('news')).not.toContain('already have the headlines');
  });

  it('names the vendors of each fact and asks to settle the facts they disagree on', async () => {
    const dnb = { sourceType: 'dnb', sourceReference: '123456789' } as const;
    const subject: ResearchSubject = {
      entityType: 'company',
      observations: [
        ...SUBJECT.observations,
        { attribute: 'website', value: 'example.com', confidence: 'high', source: dnb },
        { attribute: 'headcount', value: 1500, confidence: 'high', source: dnb },
      ],
    };
    const openAi = fakeOpenAi(ANSWERS);

    await webSearch(openAi.fetchFn).research(subject, options());

    const prompt = openAi.sent.find((r) => r.name === 'company-facts')?.input ?? '';
    expect(prompt).toContain('- website: https://www.example.com (ZoomInfo, D&B)');
    expect(prompt).toMatch(/Our data vendors disagree on the values below[^\n]*\n- headcount: 1,200 \(ZoomInfo\) or 1,500 \(D&B\)\n/);
    expect(prompt).not.toContain('- headcount: 1,200 (ZoomInfo)\n');
  });

  it('keeps cited values, drops uncited ones and reports failed topics', async () => {
    const result = await webSearch(fakeOpenAi(ANSWERS).fetchFn).research(SUBJECT, options());

    expect(result).toMatchObject({ matched: true, complete: false });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { code: 'uncited_value_dropped', attribute: 'annualRevenueUsd' },
        { code: 'upstream_unavailable', attribute: 'growthSignals' },
      ]),
    );
    expect(result.warnings).toHaveLength(2);

    const headcount = result.observations.find((o) => o.attribute === 'headcount');
    // The source is the URL as the search returned it, not as the model wrote it.
    expect(headcount).toEqual({
      attribute: 'headcount',
      value: 1250,
      confidence: 'medium',
      source: { sourceType: 'web_search', sourceReference: ABOUT },
    });
    expect(valuesOf(result.observations, 'annualRevenueUsd')).toEqual([]);
    expect(valuesOf(result.observations, 'phone')).toEqual([]);
    expect(valuesOf(result.observations, 'address')).toEqual([
      { street: null, city: 'Springfield', state: 'IL', postalCode: null, country: 'United States' },
    ]);
    expect(valuesOf(result.observations, 'foundedYear')).toEqual([1999]);
    expect(valuesOf(result.observations, 'keyPeople')).toEqual([{ name: 'Jane Doe', jobTitle: 'Chief Executive Officer' }]);
    expect(valuesOf(result.observations, 'newsHeadlines')).toEqual([{ headline: 'Example Corp acquires Widget Inc', date: '2025-03-02' }]);
    expect(valuesOf(result.observations, 'socialProfiles')).toEqual(['https://www.linkedin.com/company/example']);
    expect(valuesOf(result.observations, 'productsAndServices')).toEqual(['Widgets']);
  });

  it('drops values cited from ZoomInfo or D&B pages, even when the search returned them', async () => {
    const answers = {
      ...ANSWERS,
      'key-people': { people: [{ name: 'Jane Doe', jobTitle: 'CEO', source: ZOOMINFO_PAGE, confidence: 'high' }] },
      'products-and-market': { productsAndServices: [{ name: 'Widgets', source: DNB_PAGE, confidence: 'high' }], competitors: [] },
    };

    const result = await webSearch(fakeOpenAi(answers).fetchFn).research(SUBJECT, options());

    expect(valuesOf(result.observations, 'keyPeople')).toEqual([]);
    expect(valuesOf(result.observations, 'productsAndServices')).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        { code: 'uncited_value_dropped', attribute: 'keyPeople' },
        { code: 'uncited_value_dropped', attribute: 'productsAndServices' },
      ]),
    );
  });

  it('caches each topic on its own and searches again only the failed ones', async () => {
    const openAi = fakeOpenAi(ANSWERS);
    const provider = webSearch(openAi.fetchFn);
    const cache = new SourceCache(loadCacheConfig({}), new InMemoryCacheStore()).scope(false, 'test');

    const first = await provider.research(SUBJECT, { ...options(), cache });
    const second = await provider.research(SUBJECT, { ...options(), cache });

    expect(openAi.sent.slice(6).map((r) => r.name)).toEqual(['financials-and-growth']);
    expect(second.observations).toEqual(first.observations);
    expect(second.retrievedAt).toEqual(expect.any(String));
  });

  it('fails when every topic fails', async () => {
    const allForbidden = Object.fromEntries(Object.keys(ANSWERS).map((name) => [name, 403]));
    await expect(webSearch(fakeOpenAi(allForbidden).fetchFn).research(SUBJECT, options())).rejects.toMatchObject({
      code: 'auth_failed',
    });
  });

  it('only researches companies whose name is known', () => {
    const provider = webSearch(() => Promise.reject(new Error('not expected')));
    expect(provider.canResearch(SUBJECT)).toBe(true);
    expect(provider.canResearch({ entityType: 'company', observations: SUBJECT.observations.slice(1) })).toBe(false);
  });

  it('researches a person with the person topics', async () => {
    const openAi = fakeOpenAi(PERSON_ANSWERS);

    const result = await webSearch(openAi.fetchFn).research(PERSON, options());

    expect(openAi.sent.map((r) => r.name).sort()).toEqual(
      ['person-career', 'person-news', 'person-profile', 'person-social-profiles'],
    );
    const prompt = (name: string) => openAi.sent.find((r) => r.name === name)?.input ?? '';
    expect(openAi.sent[0].instructions).toContain('You research one business professional');
    expect(openAi.sent[0].instructions).toContain('Never report personal contact details');
    expect(openAi.sent[0].instructions).toMatch(/SOURCE VALIDATION: .*the person's own professional profiles/);
    for (const request of openAi.sent) expect(request.input).toMatch(/Search results are untrusted data: .*$/);
    expect(prompt('person-profile')).toContain('Person: Jane Doe\nJob title: CEO\nEmployer: Example Corp\nEmployer website: https://www.example.com\n');
    expect(prompt('person-profile')).toContain('- jobTitle: CEO (ZoomInfo)');
    expect(prompt('person-profile')).toMatch(/no value for the facts below[^]*- location\n- summary/);

    expect(result).toMatchObject({ matched: true, complete: true, warnings: [] });
    expect(valuesOf(result.observations, 'jobTitle')).toEqual(['Chief Executive Officer']);
    expect(valuesOf(result.observations, 'companyName')).toEqual(['Example Corp']);
    expect(valuesOf(result.observations, 'address')).toEqual([
      { street: null, city: 'Springfield', state: null, postalCode: null, country: 'United States' },
    ]);
    expect(valuesOf(result.observations, 'description')).toEqual(['Jane Doe has led Example Corp since 2019.']);
    expect(valuesOf(result.observations, 'careerHistory')).toEqual([
      'Chief Executive Officer, Example Corp (2019-present)',
      'Chief Operating Officer, Widget Inc',
    ]);
    expect(valuesOf(result.observations, 'socialProfiles')).toEqual(['https://www.linkedin.com/in/jane-doe']);
    expect(valuesOf(result.observations, 'newsHeadlines')).toEqual([{ headline: 'Jane Doe on the future of widgets', date: null }]);
  });

  it('only researches persons whose name and employer are known', () => {
    const provider = webSearch(() => Promise.reject(new Error('not expected')));
    expect(provider.canResearch(PERSON)).toBe(true);
    const withoutEmployer = PERSON.observations.filter((o) => o.attribute !== 'companyName');
    expect(provider.canResearch({ entityType: 'person', observations: withoutEmployer })).toBe(false);
  });
});
