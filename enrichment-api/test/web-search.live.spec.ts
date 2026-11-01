import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResearchSubject } from '../src/enrichment/providers/provider.js';
import { WebSearchResearchProvider } from '../src/enrichment/providers/web-search.provider.js';
import { loadWebSearchConfig } from '../src/web-search/web-search.config.js';
import { WebSearchModule } from '../src/web-search/web-search.module.js';

// Opt-in test against OpenAI web search: `WEB_SEARCH_LIVE=true npm run test:live`
// (OPENAI_API_KEY from .env).
// Runs every prompt once, which costs OpenAI credits. ZoomInfo is not called: its data is faked below.
// WEB_SEARCH_LIVE=company or WEB_SEARCH_LIVE=person runs only that entity type.
if (existsSync('.env')) process.loadEnvFile('.env');
const config = loadWebSearchConfig(process.env);
const configured = config.apiKey !== null;
const enabled = process.env.WEB_SEARCH_LIVE;

const ZOOMINFO = { sourceType: 'zoominfo', sourceReference: null } as const;

const COMPANY: ResearchSubject = {
  entityType: 'company',
  observations: [
    { attribute: 'name', value: 'Marks and Spencer', confidence: 'high', source: ZOOMINFO },
    { attribute: 'website', value: 'https://www.marksandspencer.com', confidence: 'high', source: ZOOMINFO },
    { attribute: 'headcount', value: 65000, confidence: 'medium', source: ZOOMINFO },
  ],
};

const PERSON: ResearchSubject = {
  entityType: 'person',
  observations: [
    { attribute: 'name', value: 'Stuart Machin', confidence: 'high', source: ZOOMINFO },
    { attribute: 'jobTitle', value: 'Chief Executive Officer', confidence: 'high', source: ZOOMINFO },
    { attribute: 'companyName', value: 'Marks and Spencer', confidence: 'high', source: ZOOMINFO },
    { attribute: 'website', value: 'https://www.marksandspencer.com', confidence: 'high', source: ZOOMINFO },
  ],
};

function runs(entityType: string): boolean {
  return configured && (enabled === 'true' || enabled === entityType);
}

async function research(subject: ResearchSubject): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [WebSearchModule], providers: [WebSearchResearchProvider] })
    .setLogger(new ConsoleLogger())
    .compile();
  const provider = moduleRef.get(WebSearchResearchProvider);

  const started = Date.now();
  const result = await provider.research(subject, {
    deadline: Date.now() + 110_000,
    signal: new AbortController().signal,
    correlationId: 'live-test',
  });
  console.log(`${subject.entityType} took ${Date.now() - started} ms`);
  console.log(JSON.stringify(result, null, 2));

  expect(result.matched).toBe(true);
  expect(result.observations.length).toBeGreaterThan(0);
  for (const observation of result.observations) {
    expect(observation.source.sourceType).toBe('web_search');
    expect(observation.source.sourceReference).toMatch(/^https?:\/\//);
  }
}

describe('Web search live', () => {
  it.skipIf(!runs('company'))('researches a company with cited values', { timeout: 120_000 }, () => research(COMPANY));

  it.skipIf(!runs('person'))('researches a person with cited values', { timeout: 120_000 }, () => research(PERSON));
});
