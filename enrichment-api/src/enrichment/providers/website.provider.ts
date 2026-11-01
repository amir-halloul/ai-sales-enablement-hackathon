import { Inject, Injectable } from '@nestjs/common';
import { registrableDomain } from '../../common/registrable-domain.js';
import { PromptTemplates } from '../../web-search/prompt-templates.js';
import { sourceKey } from '../../web-search/web-search.client.js';
import { WebsiteCrawler, websiteUrl, type CrawledPage, type WebsiteCrawl } from '../../website/website-crawler.js';
import { WebsiteExtractionClient } from '../../website/website-extraction.client.js';
import { WEBSITE_PROMPTS } from '../../website/website.config.js';
import { WebsiteError } from '../../website/website.errors.js';
import { enrichResultEntry, throughCache, withFetchTime } from '../cache/source-cache.js';
import {
  addFact,
  address,
  ADDRESS,
  CitedObservations,
  citedList,
  citedValue,
  NEWS_ITEM,
  newsItem,
  NULLABLE_INTEGER,
  NULLABLE_STRING,
  object,
  positiveInteger,
  record,
  records,
  STRING,
  text,
  year,
  type Json,
} from './model-answer.js';
import {
  ProviderError,
  type Observation,
  type ProviderCallOptions,
  type ProviderEnrichResult,
  type ResearchProvider,
  type ResearchSubject,
} from './provider.js';

/** Time kept for the model after the crawl. */
const EXTRACTION_RESERVE_MS = 30_000;
/** Below this, the crawl would not get past the home page. */
const MIN_CRAWL_MS = 3_000;
const OPERATION = 'website-extract';

const EXTRACTION_SCHEMA = object({
  description: citedValue(NULLABLE_STRING),
  headquarters: citedValue(ADDRESS),
  phone: citedValue(NULLABLE_STRING),
  headcount: citedValue(NULLABLE_INTEGER),
  foundedYear: citedValue(NULLABLE_INTEGER),
  productsAndServices: citedList({ name: STRING }),
  technologies: citedList({ name: STRING }),
  keyPeople: citedList({ name: STRING, jobTitle: STRING }),
  openPositions: citedList({ jobTitle: STRING, location: NULLABLE_STRING }),
  growthSignals: citedList({ summary: STRING }),
  newsHeadlines: citedList(NEWS_ITEM),
});

/** Values available to the prompt templates. */
export interface WebsitePromptContext {
  today: string;
  company: { name: string; website: string };
  pages: CrawledPage[];
}

/**
 * Crawls the company's own website, then has an OpenAI model extract the company data from the pages in one call.
 * Social profiles are read from the links on the pages, without the model.
 */
@Injectable()
export class WebsiteResearchProvider implements ResearchProvider {
  readonly name = 'web_page';

  constructor(
    @Inject(WebsiteCrawler) private readonly crawler: WebsiteCrawler,
    @Inject(WebsiteExtractionClient) private readonly client: WebsiteExtractionClient,
    @Inject(WEBSITE_PROMPTS) private readonly templates: PromptTemplates,
  ) {
    for (const name of ['instructions', 'extract']) {
      if (!templates.has(name)) throw new Error(`Prompt template prompts/website/${name}.hbs is missing`);
    }
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  canResearch(subject: ResearchSubject): boolean {
    return subject.entityType === 'company' && companyWebsite(subject) !== undefined;
  }

  /** Cached by the site's registrable domain: www.example.com and example.com/about are the same site. */
  async research(subject: ResearchSubject, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
    const website = companyWebsite(subject);
    if (!website) throw new ProviderError('invalid_request');
    const entry = enrichResultEntry('web_page', [registrableDomain(website) ?? website, this.templates.version, this.client.model]);
    return withFetchTime(await throughCache(options, entry, () => this.crawlAndExtract(subject, website, options)));
  }

  private async crawlAndExtract(subject: ResearchSubject, website: string, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
    const crawlDeadline = options.deadline - EXTRACTION_RESERVE_MS;
    if (crawlDeadline - Date.now() < MIN_CRAWL_MS) throw new ProviderError('timeout');

    const crawl = await this.crawl(website, { ...options, deadline: crawlDeadline });
    const profiles = socialProfileObservations(crawl);
    if (crawl.pages.length === 0) return partialResult(profiles, 'no_page_content');

    let found: CitedObservations;
    try {
      found = await this.extract(subject, website, crawl.pages, options);
    } catch (error) {
      if (error instanceof WebsiteError) return partialResult(profiles, error.code);
      throw error;
    }
    const warnings = [...found.uncited].map((attribute) => ({ code: 'uncited_value_dropped', attribute }));
    return { matched: true, complete: true, observations: [...profiles, ...found.items], warnings };
  }

  private async crawl(website: string, options: ProviderCallOptions): Promise<WebsiteCrawl> {
    try {
      return await this.crawler.crawl(website, options);
    } catch (error) {
      if (error instanceof WebsiteError) throw new ProviderError(error.code);
      throw error;
    }
  }

  private async extract(
    subject: ResearchSubject,
    website: string,
    pages: CrawledPage[],
    options: ProviderCallOptions,
  ): Promise<CitedObservations> {
    const context: WebsitePromptContext = {
      today: new Date().toISOString().slice(0, 10),
      company: { name: companyName(subject) ?? website, website },
      pages: pages.map(asPromptPage),
    };
    const request = {
      operation: OPERATION,
      instructions: this.templates.render('instructions', context),
      input: this.templates.render('extract', context),
      schemaName: 'website_company_facts',
      schema: EXTRACTION_SCHEMA,
    };
    const answer = await this.client.extract(request, options);
    const found = new CitedObservations('web_page', pageResolver(pages));
    readExtraction(answer.output, found);
    return found;
  }
}

function readExtraction(output: unknown, found: CitedObservations): void {
  const answer = record(output);
  addFact(found, answer, 'description', 'description', text);
  addFact(found, answer, 'address', 'headquarters', address);
  addFact(found, answer, 'phone', 'phone', text);
  addFact(found, answer, 'headcount', 'headcount', positiveInteger);
  addFact(found, answer, 'foundedYear', 'foundedYear', year);
  for (const item of records(answer.productsAndServices)) found.add('productsAndServices', text(item.name), item);
  for (const item of records(answer.technologies)) found.add('technologies', text(item.name), item);
  for (const item of records(answer.openPositions)) found.add('openPositions', formatOpening(item), item);
  for (const item of records(answer.growthSignals)) found.add('growthSignals', text(item.summary), item);
  for (const item of records(answer.newsHeadlines)) found.add('newsHeadlines', newsItem(item), item);
  for (const person of records(answer.keyPeople)) {
    const name = text(person.name);
    const jobTitle = text(person.jobTitle);
    if (name && jobTitle) found.add('keyPeople', { name, jobTitle }, person);
  }
}

/** "Senior Data Engineer (Toronto)" */
function formatOpening(opening: Json): string | undefined {
  const jobTitle = text(opening.jobTitle);
  if (!jobTitle) return undefined;
  const location = text(opening.location);
  return location ? `${jobTitle} (${location})` : jobTitle;
}

/** A cited URL counts only when it is one of the crawled pages. */
function pageResolver(pages: CrawledPage[]): (cited: unknown) => string | undefined {
  const byKey = new Map<string, string>();
  for (const page of pages) {
    const key = sourceKey(page.url);
    if (key !== undefined) byKey.set(key, page.url);
  }
  return (cited) => {
    const key = typeof cited === 'string' ? sourceKey(cited) : undefined;
    return key === undefined ? undefined : byKey.get(key);
  };
}

/** The company links to these profiles from its own website, so they are official. */
function socialProfileObservations(crawl: WebsiteCrawl): Observation[] {
  const observations: Observation[] = [];
  for (const [profile, page] of crawl.socialProfiles) {
    observations.push({
      attribute: 'socialProfiles',
      value: profile,
      confidence: 'high',
      source: { sourceType: 'web_page', sourceReference: page },
    });
  }
  return observations;
}

/** Without page text only the social profiles remain; the provider fails when there are none either. */
function partialResult(profiles: Observation[], code: ProviderError['code'] | 'no_page_content'): ProviderEnrichResult {
  if (profiles.length === 0) throw new ProviderError(code === 'no_page_content' ? 'upstream_unavailable' : code);
  return { matched: true, complete: false, observations: profiles, warnings: [{ code, attribute: null }] };
}

/** Page text must not be able to close its <page> element and pose as instructions. */
function asPromptPage(page: CrawledPage): CrawledPage {
  return {
    url: page.url,
    title: page.title?.replace(/["<>]/g, '') ?? null,
    markdown: page.markdown.replace(/<\/?page\b/gi, ''),
  };
}

function companyWebsite(subject: ResearchSubject): string | undefined {
  const website = subject.observations.find((o) => o.attribute === 'website')?.value;
  return typeof website === 'string' && websiteUrl(website) ? website : undefined;
}

function companyName(subject: ResearchSubject): string | undefined {
  const name = subject.observations.find((o) => o.attribute === 'name')?.value;
  return typeof name === 'string' ? name : undefined;
}
