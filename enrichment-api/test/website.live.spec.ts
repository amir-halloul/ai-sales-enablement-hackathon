import { ConsoleLogger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ResearchSubject } from '../src/enrichment/providers/provider.js';
import { WebsiteResearchProvider } from '../src/enrichment/providers/website.provider.js';
import { createPublicPageFetch } from '../src/website/safe-fetch.js';
import { WebsiteCrawler } from '../src/website/website-crawler.js';
import { loadWebsiteConfig } from '../src/website/website.config.js';
import { WebsiteModule } from '../src/website/website.module.js';

// Opt-in tests against a real website: `WEBSITE_LIVE=crawl npm run test:live` only crawls (free);
// `WEBSITE_LIVE=true` also extracts with OpenAI (OPENAI_API_KEY from .env), which costs credits.
// WEBSITE_LIVE_URL picks the website, WEBSITE_LIVE_NAME the company name.
if (existsSync('.env')) process.loadEnvFile('.env');
const enabled = process.env.WEBSITE_LIVE;
// Sites with bot protection answer 403 to any client that is not a browser, so the default is a site without it.
const website = process.env.WEBSITE_LIVE_URL ?? 'www.snowflake.com';
const name = process.env.WEBSITE_LIVE_NAME ?? 'Snowflake';

const ZOOMINFO = { sourceType: 'zoominfo', sourceReference: null } as const;

const COMPANY: ResearchSubject = {
  entityType: 'company',
  observations: [
    { attribute: 'name', value: name, confidence: 'high', source: ZOOMINFO },
    { attribute: 'website', value: website, confidence: 'high', source: ZOOMINFO },
  ],
};

async function compile() {
  return Test.createTestingModule({ imports: [WebsiteModule], providers: [WebsiteResearchProvider] })
    .setLogger(new ConsoleLogger())
    .compile();
}

describe('Website live', () => {
  it.skipIf(enabled !== 'crawl' && enabled !== 'true')('crawls a company website', { timeout: 60_000 }, async () => {
    const crawler = new WebsiteCrawler(loadWebsiteConfig({}), createPublicPageFetch());

    const started = Date.now();
    const crawl = await crawler.crawl(website, { deadline: Date.now() + 30_000, signal: new AbortController().signal });
    console.log(`crawl took ${Date.now() - started} ms`);
    for (const page of crawl.pages) console.log(`${page.url} (${page.markdown.length} chars) ${page.title ?? ''}`);
    console.log(JSON.stringify([...crawl.socialProfiles], null, 2));

    expect(crawl.pages.length).toBeGreaterThan(0);
  });

  it.skipIf(enabled !== 'true')('researches a company from its website', { timeout: 120_000 }, async () => {
    const provider = (await compile()).get(WebsiteResearchProvider);

    const started = Date.now();
    const result = await provider.research(COMPANY, {
      deadline: Date.now() + 90_000,
      signal: new AbortController().signal,
      correlationId: 'live-test',
    });
    console.log(`research took ${Date.now() - started} ms`);
    console.log(JSON.stringify(result, null, 2));

    expect(result.observations.length).toBeGreaterThan(0);
    for (const observation of result.observations) expect(observation.source.sourceType).toBe('web_page');
  });
});
