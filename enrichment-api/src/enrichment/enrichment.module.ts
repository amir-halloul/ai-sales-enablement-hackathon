import { Module } from '@nestjs/common';
import { DnbModule } from '../dnb/dnb.module.js';
import { SNOWFLAKE_SQL_FETCH } from '../snowflake/snowflake-sql.config.js';
import { PromptTemplates } from '../web-search/prompt-templates.js';
import { WebSearchModule } from '../web-search/web-search.module.js';
import { WebsiteExtractionClient } from '../website/website-extraction.client.js';
import { WebsiteModule } from '../website/website.module.js';
import { ZoomInfoModule } from '../zoominfo/zoominfo.module.js';
import { CACHE_CONFIG, loadCacheConfig } from './cache/cache.config.js';
import { SnowflakeCacheStore } from './cache/snowflake-cache-store.js';
import { CACHE_STORE, SourceCache } from './cache/source-cache.js';
import { loadConsolidationConfig } from './consolidation/consolidation.config.js';
import {
  CONSOLIDATION_CLIENT,
  CONSOLIDATION_PROMPTS,
  CONSOLIDATION_PROMPTS_DIR,
  ListConsolidator,
} from './consolidation/list-consolidator.js';
import { ENRICHMENT_CONFIG, loadEnrichmentConfig } from './enrichment.config.js';
import { EnrichmentController } from './enrichment.controller.js';
import { EnrichmentService } from './enrichment.service.js';
import { EntityIds } from './entities/entity-ids.js';
import { ENTITY_STORE_CONFIG, loadEntityStoreConfig } from './entities/entity-store.config.js';
import { ENTITY_TABLE } from './entities/entity-table.js';
import { SnowflakeEntityTable } from './entities/snowflake-entity-table.js';
import { EnrichmentHistory, HISTORY_CONFIG, loadHistoryConfig } from './history/enrichment-history.js';
import { ENRICHMENT_PROVIDERS, RESEARCH_PROVIDERS, type EnrichmentProvider, type ResearchProvider } from './providers/provider.js';
import { DnbEnrichmentProvider } from './providers/dnb.provider.js';
import { RATE_LIMIT_CONFIG, loadRateLimitConfig } from './rate-limit/rate-limit.config.js';
import { RequestRateLimiter } from './rate-limit/request-rate-limiter.js';
import { WebSearchResearchProvider } from './providers/web-search.provider.js';
import { WebsiteResearchProvider } from './providers/website.provider.js';
import { ZoomInfoEnrichmentProvider } from './providers/zoominfo.provider.js';

@Module({
  imports: [ZoomInfoModule, DnbModule, WebSearchModule, WebsiteModule],
  controllers: [EnrichmentController],
  providers: [
    { provide: ENRICHMENT_CONFIG, useFactory: () => loadEnrichmentConfig(process.env) },
    { provide: RATE_LIMIT_CONFIG, useFactory: () => loadRateLimitConfig(process.env) },
    RequestRateLimiter,
    ZoomInfoEnrichmentProvider,
    DnbEnrichmentProvider,
    WebSearchResearchProvider,
    WebsiteResearchProvider,
    // Same OpenAI chat completions API as the website extraction, with its own switch and model.
    {
      provide: CONSOLIDATION_CLIENT,
      useFactory: () => new WebsiteExtractionClient(loadConsolidationConfig(process.env), (input, init) => fetch(input, init)),
    },
    { provide: CONSOLIDATION_PROMPTS, useFactory: () => PromptTemplates.load(CONSOLIDATION_PROMPTS_DIR) },
    ListConsolidator,
    { provide: SNOWFLAKE_SQL_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies typeof fetch },
    { provide: ENTITY_STORE_CONFIG, useFactory: () => loadEntityStoreConfig(process.env) },
    { provide: ENTITY_TABLE, useClass: SnowflakeEntityTable },
    EntityIds,
    { provide: CACHE_CONFIG, useFactory: () => loadCacheConfig(process.env) },
    { provide: CACHE_STORE, useClass: SnowflakeCacheStore },
    SourceCache,
    { provide: HISTORY_CONFIG, useFactory: () => loadHistoryConfig(process.env) },
    EnrichmentHistory,
    // Order is precedence when providers disagree.
    {
      provide: ENRICHMENT_PROVIDERS,
      useFactory: (zoomInfo: ZoomInfoEnrichmentProvider, dnb: DnbEnrichmentProvider): EnrichmentProvider[] => [zoomInfo, dnb],
      inject: [ZoomInfoEnrichmentProvider, DnbEnrichmentProvider],
    },
    {
      provide: RESEARCH_PROVIDERS,
      useFactory: (webSearch: WebSearchResearchProvider, website: WebsiteResearchProvider): ResearchProvider[] => [webSearch, website],
      inject: [WebSearchResearchProvider, WebsiteResearchProvider],
    },
    EnrichmentService,
  ],
})
export class EnrichmentModule {}
