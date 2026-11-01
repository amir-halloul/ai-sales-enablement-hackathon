import { Module } from '@nestjs/common';
import { PromptTemplates } from '../web-search/prompt-templates.js';
import { createPublicPageFetch } from './safe-fetch.js';
import { WebsiteCrawler } from './website-crawler.js';
import { WebsiteExtractionClient } from './website-extraction.client.js';
import { loadWebsiteConfig, WEBSITE_CONFIG, WEBSITE_OPENAI_FETCH, WEBSITE_PAGE_FETCH, WEBSITE_PROMPTS } from './website.config.js';

/** Resolves to <repo>/prompts/website from both src/ (tests) and dist/ (build). */
export const WEBSITE_PROMPTS_DIR = new URL('../../prompts/website/', import.meta.url);

@Module({
  providers: [
    { provide: WEBSITE_CONFIG, useFactory: () => loadWebsiteConfig(process.env) },
    { provide: WEBSITE_PAGE_FETCH, useFactory: createPublicPageFetch },
    { provide: WEBSITE_OPENAI_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies typeof fetch },
    { provide: WEBSITE_PROMPTS, useFactory: () => PromptTemplates.load(WEBSITE_PROMPTS_DIR) },
    WebsiteCrawler,
    WebsiteExtractionClient,
  ],
  exports: [WebsiteCrawler, WebsiteExtractionClient, WEBSITE_PROMPTS],
})
export class WebsiteModule {}
