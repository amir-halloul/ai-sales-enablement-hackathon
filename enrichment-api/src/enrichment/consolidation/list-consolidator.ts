import { Inject, Injectable, Logger } from '@nestjs/common';
import type { PromptTemplates } from '../../web-search/prompt-templates.js';
import type { WebsiteExtractionClient } from '../../website/website-extraction.client.js';
import { WebsiteError } from '../../website/website.errors.js';
import { throughCache, type CacheEntry } from '../cache/source-cache.js';
import type { AttributedValue, EntityType, EnrichmentWarning, NewsHeadline } from '../enrichment.types.js';
import { sortNewestFirst } from '../list-cleanup.js';
import { object, record, records, STRING, text, type Json, type JsonSchema } from '../providers/model-answer.js';
import type { ProviderCallOptions } from '../providers/provider.js';
import { earliestDate, mergeItems, type Reconciled } from '../reconcile.js';

export const CONSOLIDATION_CLIENT = Symbol('CONSOLIDATION_CLIENT');
export const CONSOLIDATION_PROMPTS = Symbol('CONSOLIDATION_PROMPTS');

/** Resolves to <repo>/prompts/consolidation from both src/ (tests) and dist/ (build). */
export const CONSOLIDATION_PROMPTS_DIR = new URL('../../../prompts/consolidation/', import.meta.url);

export type ConsolidationClient = Pick<WebsiteExtractionClient, 'isAvailable' | 'model' | 'extract'>;

const OPERATION = 'consolidate-lists';
const MAX_NEWS = 10;
const MAX_PRODUCTS = 20;
/** Longer names are descriptions, not product names. */
const MAX_PRODUCT_NAME_LENGTH = 80;
const MAX_ITEM_LENGTH = 300;
const MAX_DESCRIPTION_LENGTH = 1_000;

const CONSOLIDATION_FAILED: EnrichmentWarning = { code: 'consolidation_failed', provider: null, attribute: null };

const IDS = { type: 'array', items: { type: 'integer' } };
const SCHEMA: JsonSchema = object({
  news: { type: 'array', items: object({ ids: IDS }) },
  productsAndServices: { type: 'array', items: object({ name: STRING, ids: IDS }) },
});

/** Values available to the prompt templates. Item ids start at 1. */
export interface ConsolidationPromptContext {
  today: string;
  entityType: EntityType;
  subjectName: string;
  company: { name: string; website: string | null; industry: string | null; description: string | null } | null;
  person: { name: string; jobTitle: string | null; companyName: string | null } | null;
  maxNews: number;
  maxProducts: number;
  news: { id: number; headline: string; date: string | null }[];
  products: { id: number; name: string }[];
}

interface ResolvedGroup<T> {
  group: Json;
  members: T[];
}

/**
 * Has an OpenAI model consolidate what the static rules can't: news that tells the same story in other words or
 * isn't about the entity, and product entries that are duplicates, fragments or not products at all.
 * The model only groups and drops items by id (and names the product groups), so every item it keeps still
 * carries the sources that reported it.
 */
@Injectable()
export class ListConsolidator {
  private readonly logger = new Logger('Consolidation');

  constructor(
    @Inject(CONSOLIDATION_CLIENT) private readonly client: ConsolidationClient,
    @Inject(CONSOLIDATION_PROMPTS) private readonly templates: PromptTemplates,
  ) {
    for (const name of ['instructions', 'consolidate']) {
      if (!templates.has(name)) throw new Error(`Prompt template prompts/consolidation/${name}.hbs is missing`);
    }
  }

  isAvailable(): boolean {
    return this.client.isAvailable();
  }

  /** Never fails: without an answer from the model, the lists stay as the static rules left them. */
  async consolidate(entityType: EntityType, reconciled: Reconciled, options: ProviderCallOptions): Promise<Reconciled> {
    const products = reconciled.lists.productsAndServices;
    if (!this.isAvailable() || (reconciled.news.length === 0 && products.length === 0)) return reconciled;

    const context = promptContext(entityType, reconciled);
    // The same lists give the same answer, whatever the day.
    const entry: CacheEntry<Json> = {
      source: 'consolidation',
      key: [{ ...context, today: null }, this.templates.version, this.client.model],
      read: readAnswer,
      keep: () => true,
    };
    let output: Json;
    try {
      output = (await throughCache(options, entry, () => this.ask(context, options))).value;
    } catch (error) {
      this.logFailure(error, options.correlationId);
      return { ...reconciled, warnings: [...reconciled.warnings, CONSOLIDATION_FAILED] };
    }

    return {
      ...reconciled,
      news: consolidateNews(reconciled.news, records(output.news)),
      lists: { ...reconciled.lists, productsAndServices: consolidateProducts(products, records(output.productsAndServices)) },
    };
  }

  private async ask(context: ConsolidationPromptContext, options: ProviderCallOptions): Promise<Json> {
    const request = {
      operation: OPERATION,
      instructions: this.templates.render('instructions', context),
      input: this.templates.render('consolidate', context),
      schemaName: 'consolidated_lists',
      schema: SCHEMA,
    };
    return record((await this.client.extract(request, options)).output);
  }

  private logFailure(error: unknown, correlationId: string): void {
    if (error instanceof WebsiteError) {
      this.logger.warn({ event: 'consolidation.failed', code: error.code, correlationId });
      return;
    }
    // Anything else is a bug, but it must not fail a request whose data is already collected.
    this.logger.error({ event: 'consolidation.unexpected_error', correlationId }, error instanceof Error ? error.stack : undefined);
  }
}

function readAnswer(json: unknown): Json | null {
  return typeof json === 'object' && json !== null && !Array.isArray(json) ? (json as Json) : null;
}

/** Each group is one story: its first id gives the headline, the others are the same story reported elsewhere. */
function consolidateNews(news: NewsHeadline[], groups: Json[]): NewsHeadline[] {
  const stories: NewsHeadline[] = [];
  for (const { members } of resolveGroups(news, groups)) {
    const headline = mergeItems(members[0].value, members);
    stories.push({ ...headline, date: earliestDate(members.map((m) => m.date)) });
  }
  // The model ranks by importance, so the cap keeps the most important stories.
  return sortNewestFirst(stories.slice(0, MAX_NEWS));
}

/** Each group is one product or service, under the name the model gave it. */
function consolidateProducts(products: AttributedValue<string>[], groups: Json[]): AttributedValue<string>[] {
  const consolidated: AttributedValue<string>[] = [];
  for (const { group, members } of resolveGroups(products, groups)) {
    const name = productName(group.name) ?? members[0].value;
    consolidated.push(mergeItems(name, members));
  }
  return consolidated.slice(0, MAX_PRODUCTS);
}

/** Resolves the ids of each group to items, ignoring unknown ids and ids already used by an earlier group. */
function resolveGroups<T>(items: T[], groups: Json[]): ResolvedGroup<T>[] {
  const used = new Set<number>();
  const resolved: ResolvedGroup<T>[] = [];
  for (const group of groups) {
    const members: T[] = [];
    for (const id of integers(group.ids)) {
      if (id < 1 || id > items.length || used.has(id)) continue;
      used.add(id);
      members.push(items[id - 1]);
    }
    if (members.length > 0) resolved.push({ group, members });
  }
  return resolved;
}

function promptContext(entityType: EntityType, reconciled: Reconciled): ConsolidationPromptContext {
  return {
    today: new Date().toISOString().slice(0, 10),
    entityType,
    subjectName: reconciled.scalars.name?.value ?? '',
    company: entityType === 'company' ? companyContext(reconciled) : null,
    person: entityType === 'person' ? personContext(reconciled) : null,
    maxNews: MAX_NEWS,
    maxProducts: MAX_PRODUCTS,
    news: reconciled.news.map((item, index) => ({ id: index + 1, headline: oneLine(item.value, MAX_ITEM_LENGTH), date: item.date })),
    products: reconciled.lists.productsAndServices.map((item, index) => ({ id: index + 1, name: oneLine(item.value, MAX_ITEM_LENGTH) })),
  };
}

function companyContext({ scalars }: Reconciled): ConsolidationPromptContext['company'] {
  const description = scalars.description?.value;
  return {
    name: scalars.name?.value ?? '',
    website: scalars.website?.value ?? null,
    industry: scalars.industry?.value ?? null,
    description: description === undefined ? null : oneLine(description, MAX_DESCRIPTION_LENGTH),
  };
}

function personContext({ scalars }: Reconciled): ConsolidationPromptContext['person'] {
  return {
    name: scalars.name?.value ?? '',
    jobTitle: scalars.jobTitle?.value ?? null,
    companyName: scalars.companyName?.value ?? null,
  };
}

/** One line of plain text, so a list item can't pose as other items or as instructions. */
function oneLine(value: string, maxLength: number): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function productName(value: unknown): string | undefined {
  const name = text(value);
  return name !== undefined && name.length <= MAX_PRODUCT_NAME_LENGTH ? name : undefined;
}

function integers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return (value as unknown[]).filter((item): item is number => Number.isInteger(item));
}
