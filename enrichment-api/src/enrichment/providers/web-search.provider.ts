import { Inject, Injectable } from '@nestjs/common';
import { registrableDomain } from '../../common/registrable-domain.js';
import { PromptTemplates } from '../../web-search/prompt-templates.js';
import { citedSource, WebSearchClient } from '../../web-search/web-search.client.js';
import { WebSearchError } from '../../web-search/web-search.errors.js';
import { throughCache, type CacheEntry } from '../cache/source-cache.js';
import type { Address, SourceType } from '../enrichment.types.js';
import { sameValue } from '../reconcile.js';
import { CitedObservations } from './model-answer.js';
import {
  ProviderError,
  type Observation,
  type ObservedValues,
  type ProviderCallOptions,
  type ProviderEnrichResult,
  type ResearchProvider,
  type ResearchSubject,
} from './provider.js';
import { COMPANY_TOPICS, PERSON_TOPICS, type Topic } from './web-search.topics.js';

/** The company-facts prompt verifies these attributes, under these field names. */
const COMPANY_FACT_FIELDS = {
  website: 'website',
  address: 'headquarters',
  phone: 'phone',
  headcount: 'headcount',
  annualRevenueUsd: 'annualRevenueUsd',
  ownershipType: 'ownershipType',
  tickerSymbol: 'tickerSymbol',
  foundedYear: 'foundedYear',
} satisfies Partial<Record<keyof ObservedValues, string>>;

/** The person-profile prompt verifies these attributes, under these field names. */
const PERSON_FACT_FIELDS = {
  jobTitle: 'jobTitle',
  companyName: 'employer',
  address: 'location',
  description: 'summary',
} satisfies Partial<Record<keyof ObservedValues, string>>;

type FactFields = Partial<Record<keyof ObservedValues, string>>;

/** Keeps prompts short: the model only needs a sample of what is already known. */
const MAX_KNOWN_ITEMS = 15;

/** The values to verify come from these data vendors, so their own pages confirm nothing. */
const VENDOR_DOMAINS = new Set(['zoominfo.com', 'dnb.com', 'dandb.com', 'hoovers.com']);

const VENDOR_NAMES: Partial<Record<SourceType, string>> = { zoominfo: 'ZoomInfo', dnb: 'D&B' };

/** A value of a fact and the vendors that report it. */
interface VendorValue {
  value: string;
  vendors: string;
}

interface FactContext {
  /** Facts all vendors agree on. */
  knownFacts: ({ field: string } & VendorValue)[];
  /** Facts the vendors disagree on, with each vendor's value. */
  disputedFacts: { field: string; values: VendorValue[] }[];
  missingFacts: string[];
}

/** Values available to the prompt templates. */
export interface CompanyPromptContext extends FactContext {
  today: string;
  company: { name: string; website: string | null; location: string | null };
  knownPeople: string[];
  knownHeadlines: string[];
  knownProducts: string[];
  knownCompetitors: string[];
  knownSocialProfiles: string[];
}

export interface PersonPromptContext extends FactContext {
  today: string;
  person: { name: string; jobTitle: string | null; companyName: string; companyWebsite: string | null; location: string | null };
}

type PromptContext = CompanyPromptContext | PersonPromptContext;

/** What one topic found, as plain data so it can be cached. */
interface TopicFindings {
  observations: Observation[];
  uncited: string[];
}

type TopicRun = { topic: Topic; found: TopicFindings; fetchedAt: string | null } | { topic: Topic; error: ProviderError };

/**
 * Researches an entity found by the lookup providers with several web search prompts in parallel. The prompts
 * include what the data vendors already know, so the model verifies those values and focuses on the gaps.
 */
@Injectable()
export class WebSearchResearchProvider implements ResearchProvider {
  readonly name = 'web_search';

  constructor(
    @Inject(WebSearchClient) private readonly client: WebSearchClient,
    @Inject(PromptTemplates) private readonly templates: PromptTemplates,
  ) {
    const topics = [...COMPANY_TOPICS, ...PERSON_TOPICS];
    for (const name of ['instructions', ...topics.map((topic) => topic.name)]) {
      if (!templates.has(name)) throw new Error(`Prompt template prompts/web-search/${name}.hbs is missing`);
    }
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  /** A person also needs an employer: a name alone matches too many people. */
  canResearch(subject: ResearchSubject): boolean {
    const named = firstValue(subject.observations, 'name') !== undefined;
    if (subject.entityType === 'person') return named && firstValue(subject.observations, 'companyName') !== undefined;
    return named;
  }

  async research(subject: ResearchSubject, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
    const { topics, context } = researchPlan(subject);
    const instructions = this.templates.render('instructions', context);
    const runs = await Promise.all(topics.map((topic) => this.runTopic(topic, instructions, context, options)));
    return combineRuns(runs);
  }

  /** Each topic is cached on its own, so one failed topic doesn't cost the others. */
  private async runTopic(topic: Topic, instructions: string, context: PromptContext, options: ProviderCallOptions): Promise<TopicRun> {
    const entry: CacheEntry<TopicFindings> = {
      source: `web_search:${topic.name}`,
      key: [subjectOf(context), this.templates.version, this.client.model],
      read: readTopicFindings,
      keep: () => true,
    };
    try {
      const { value, fetchedAt } = await throughCache(options, entry, () => this.search(topic, instructions, context, options));
      return { topic, found: value, fetchedAt };
    } catch (error) {
      if (error instanceof WebSearchError) return { topic, error: new ProviderError(error.code) };
      throw error;
    }
  }

  private async search(topic: Topic, instructions: string, context: PromptContext, options: ProviderCallOptions): Promise<TopicFindings> {
    const request = {
      operation: topic.name,
      instructions,
      input: this.templates.render(topic.name, context),
      schemaName: topic.name,
      schema: topic.schema,
    };
    const answer = await this.client.search(request, options);
    const found = new CitedObservations('web_search', (url) => independentSource(citedSource(answer, url)));
    topic.read(answer.output, found);
    return { observations: found.items, uncited: [...found.uncited] };
  }
}

/** Who the prompt is about; the known facts only steer the search, so they don't change the cache key. */
function subjectOf(context: PromptContext): unknown {
  return 'person' in context ? context.person : context.company;
}

/** A value cited from a data vendor's page is dropped, as if it had no source. */
function independentSource(url: string | undefined): string | undefined {
  const domain = registrableDomain(url);
  if (domain !== undefined && VENDOR_DOMAINS.has(domain)) return undefined;
  return url;
}

function readTopicFindings(json: unknown): TopicFindings | null {
  if (typeof json !== 'object' || json === null) return null;
  const { observations, uncited } = json as Record<string, unknown>;
  if (!Array.isArray(observations) || !Array.isArray(uncited)) return null;
  const attributes = (uncited as unknown[]).filter((item): item is string => typeof item === 'string');
  return { observations: observations as Observation[], uncited: attributes };
}

/** Failed topics only make the result partial; the provider fails when every topic failed. */
function combineRuns(runs: TopicRun[]): ProviderEnrichResult {
  const observations: Observation[] = [];
  const warnings: ProviderEnrichResult['warnings'] = [];
  const errors: ProviderError[] = [];
  let oldestFetch: string | null = null;

  for (const run of runs) {
    if ('error' in run) {
      errors.push(run.error);
      warnings.push({ code: run.error.code, attribute: run.topic.attribute });
      continue;
    }
    observations.push(...run.found.observations);
    for (const attribute of run.found.uncited) warnings.push({ code: 'uncited_value_dropped', attribute });
    if (run.fetchedAt !== null && (oldestFetch === null || run.fetchedAt < oldestFetch)) oldestFetch = run.fetchedAt;
  }

  if (errors.length === runs.length) throw errors[0];
  const result: ProviderEnrichResult = { matched: true, complete: errors.length === 0, observations, warnings };
  if (oldestFetch !== null) result.retrievedAt = oldestFetch;
  return result;
}

export function companyPromptContext(observations: Observation[]): CompanyPromptContext {
  const address = firstValue(observations, 'address');
  return {
    today: today(),
    company: {
      name: firstValue(observations, 'name') ?? '',
      website: firstValue(observations, 'website') ?? null,
      location: address ? formatLocation(address) : null,
    },
    ...facts(observations, COMPANY_FACT_FIELDS),
    knownPeople: allValues(observations, 'keyPeople').map((person) => `${person.name}, ${person.jobTitle}`),
    knownHeadlines: allValues(observations, 'newsHeadlines').map((article) => article.headline),
    knownProducts: allValues(observations, 'productsAndServices'),
    knownCompetitors: allValues(observations, 'competitors'),
    knownSocialProfiles: allValues(observations, 'socialProfiles'),
  };
}

export function personPromptContext(observations: Observation[]): PersonPromptContext {
  const address = firstValue(observations, 'address');
  return {
    today: today(),
    person: {
      name: firstValue(observations, 'name') ?? '',
      jobTitle: firstValue(observations, 'jobTitle') ?? null,
      companyName: firstValue(observations, 'companyName') ?? '',
      companyWebsite: firstValue(observations, 'website') ?? null,
      location: address ? formatLocation(address) : null,
    },
    ...facts(observations, PERSON_FACT_FIELDS),
  };
}

function researchPlan(subject: ResearchSubject): { topics: readonly Topic[]; context: PromptContext } {
  if (subject.entityType === 'person') return { topics: PERSON_TOPICS, context: personPromptContext(subject.observations) };
  return { topics: COMPANY_TOPICS, context: companyPromptContext(subject.observations) };
}

/** Sorts the fact fields into values the vendors agree on, values they disagree on, and missing values. */
function facts(observations: Observation[], fields: FactFields): FactContext {
  const result: FactContext = { knownFacts: [], disputedFacts: [], missingFacts: [] };
  for (const [attribute, field] of Object.entries(fields)) {
    const values = vendorValues(observations, attribute);
    if (values.length === 0) result.missingFacts.push(field);
    else if (values.length === 1) result.knownFacts.push({ field, ...values[0] });
    else result.disputedFacts.push({ field, values });
  }
  return result;
}

/** The distinct values reported for an attribute, counting only the first value of each vendor. */
function vendorValues(observations: Observation[], attribute: string): VendorValue[] {
  const groups: Observation[][] = [];
  const seenVendors = new Set<SourceType>();
  for (const observation of observations) {
    if (observation.attribute !== attribute || seenVendors.has(observation.source.sourceType)) continue;
    seenVendors.add(observation.source.sourceType);

    const group = groups.find((g) => sameValue(attribute, g[0].value, observation.value));
    if (group) group.push(observation);
    else groups.push([observation]);
  }
  return groups.map((group) => ({ value: formatValue(group[0].value), vendors: vendorNames(group) }));
}

function vendorNames(observations: Observation[]): string {
  const types = observations.map((o) => o.source.sourceType);
  return types.map((type) => VENDOR_NAMES[type] ?? type).join(', ');
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function firstValue<K extends keyof ObservedValues>(observations: Observation[], attribute: K): ObservedValues[K] | undefined {
  return observations.find((o) => o.attribute === attribute)?.value as ObservedValues[K] | undefined;
}

function allValues<K extends keyof ObservedValues>(observations: Observation[], attribute: K): ObservedValues[K][] {
  const matching = observations.filter((o) => o.attribute === attribute).slice(0, MAX_KNOWN_ITEMS);
  return matching.map((o) => o.value as ObservedValues[K]);
}

function formatValue(value: unknown): string {
  if (typeof value === 'number') return value.toLocaleString('en-US');
  if (typeof value === 'object' && value !== null) return formatAddress(value as Address);
  return String(value);
}

function formatAddress(a: Address): string {
  return [a.street, a.city, a.state, a.postalCode, a.country].filter(Boolean).join(', ');
}

function formatLocation(a: Address): string | null {
  return [a.city, a.state, a.country].filter(Boolean).join(', ') || null;
}
