import { Module } from '@nestjs/common';
import { PromptTemplates, WEB_SEARCH_PROMPTS_DIR } from './prompt-templates.js';
import { WebSearchClient } from './web-search.client.js';
import { loadWebSearchConfig, WEB_SEARCH_CONFIG, WEB_SEARCH_FETCH } from './web-search.config.js';

@Module({
  providers: [
    { provide: WEB_SEARCH_CONFIG, useFactory: () => loadWebSearchConfig(process.env) },
    { provide: WEB_SEARCH_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies typeof fetch },
    { provide: PromptTemplates, useFactory: () => PromptTemplates.load(WEB_SEARCH_PROMPTS_DIR) },
    WebSearchClient,
  ],
  exports: [WebSearchClient, PromptTemplates],
})
export class WebSearchModule {}
