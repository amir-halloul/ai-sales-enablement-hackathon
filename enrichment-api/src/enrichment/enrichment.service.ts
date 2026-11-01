import { Inject, Injectable } from '@nestjs/common';
import { enrichResultEntry, SourceCache, throughCache, withFetchTime } from './cache/source-cache.js';
import { ListConsolidator } from './consolidation/list-consolidator.js';
import { ENRICHMENT_CONFIG, type EnrichmentConfig } from './enrichment.config.js';
import { allProvidersFailed, noProviderAvailable, notFound } from './enrichment.errors.js';
import type { EnrichResponse, IdentifyRequest, IdentifyResponse, ProviderName, ProviderOutcome } from './enrichment.types.js';
import { EntityIds } from './entities/entity-ids.js';
import { EnrichmentHistory } from './history/enrichment-history.js';
import { callProviders, type CallBudget, type ProviderCall } from './provider-calls.js';
import {
  ENRICHMENT_PROVIDERS,
  RESEARCH_PROVIDERS,
  type EnrichmentProvider,
  type EntityRef,
  type ProviderCallOptions,
  type ProviderEnrichResult,
  type ResearchProvider,
  type ResearchSubject,
} from './providers/provider.js';
import { reconcile } from './reconcile.js';
import { buildEnrichResponse, buildIdentifyResponse, type NamedEnrichResult, type NamedIdentifyResult } from './responses.js';
import type { EnrichTarget } from './validation.js';

export interface RequestContext {
  /** Aborted when the caller disconnects. */
  signal: AbortSignal;
  correlationId: string;
}

export interface EnrichOptions {
  /** Fetches every source again instead of reusing cached results. */
  refresh: boolean;
}

export type Consolidator = Pick<ListConsolidator, 'isAvailable' | 'consolidate'>;

/** Each identifier can only be used by the provider that issued it. */
const IDENTIFIER_OWNERS = [
  { identifier: 'zoomInfoId', provider: 'zoominfo' },
  { identifier: 'dunsNumber', provider: 'dnb' },
] as const;

/** Time kept after the research for the AI consolidation of the lists. */
const CONSOLIDATION_RESERVE_MS = 20_000;

/**
 * Runs Identify and Enrich across all providers. Every response lists one outcome per provider, so the caller
 * can tell missing data from failed or unavailable providers.
 *
 * Enrich runs in stages within one deadline: the lookup providers (ZoomInfo, D&B) in parallel, then the
 * research providers (web search, website) in parallel, which build on what the lookup providers found. The
 * observations are then reconciled with static rules, and the news and products lists consolidated by a model.
 */
@Injectable()
export class EnrichmentService {
  constructor(
    @Inject(ENRICHMENT_PROVIDERS) private readonly providers: EnrichmentProvider[],
    @Inject(RESEARCH_PROVIDERS) private readonly researchers: ResearchProvider[],
    @Inject(ENRICHMENT_CONFIG) private readonly config: EnrichmentConfig,
    @Inject(ListConsolidator) private readonly consolidator: Consolidator,
    @Inject(EntityIds) private readonly entityIds: EntityIds,
    @Inject(SourceCache) private readonly cache: SourceCache,
    @Inject(EnrichmentHistory) private readonly history: EnrichmentHistory,
  ) {}

  async identify(request: IdentifyRequest, ctx: RequestContext): Promise<IdentifyResponse> {
    const outcomes: ProviderOutcome[] = [];
    const providers: EnrichmentProvider[] = [];
    for (const provider of this.usableProviders(this.providers, outcomes)) {
      if (provider.canIdentify(request)) providers.push(provider);
      else outcomes.push(unavailableOutcome(provider.name, 'insufficient_input'));
    }
    if (providers.length === 0) throw noProviderAvailable(outcomes);
    const calls = await callProviders(providers, (provider, options) => provider.identify(request, options), this.budget(ctx));

    const results: NamedIdentifyResult[] = [];
    for (const call of calls) {
      if (!call.ok) {
        outcomes.push(failedOutcome(call.provider, call.error.code));
        continue;
      }
      const status = call.value.status === 'matched' ? 'ok' : call.value.status;
      outcomes.push({ provider: call.provider, status, error: null, retrievedAt: call.retrievedAt });
      results.push({ provider: call.provider, ...call.value });
    }

    if (results.length === 0) throw allProvidersFailed(errorsOf(calls), outcomes);
    const response = buildIdentifyResponse(request, results, outcomes);
    response.entityId = await this.entityIds.forIdentified(response, ctx);
    return response;
  }

  async enrich(target: EnrichTarget, ctx: RequestContext, { refresh }: EnrichOptions = { refresh: false }): Promise<EnrichResponse> {
    const budget = this.budget(ctx, refresh);
    const { entityId, ref } = await this.entityIds.forEnrich(target, ctx);
    const outcomes = this.unusableIdentifiers(ref);
    const providers = this.usableProviders(
      this.providers.filter((p) => p.canEnrich(ref)),
      outcomes,
    );
    const calls = await callProviders(providers, (provider, options) => lookup(provider, ref, options), budget);
    const results = collectEnrichResults(calls, outcomes);

    if (results.length === 0) {
      const someProviderAnswered = calls.some((call) => call.ok);
      throw someProviderAnswered ? notFound(outcomes) : allProvidersFailed(errorsOf(calls), outcomes);
    }
    // A provider found the entity, so its IDs are real and can get an entity.
    const resolvedEntityId = entityId ?? (await this.entityIds.register(ref, outcomes, ctx));

    const subject: ResearchSubject = { entityType: ref.entityType, observations: results.flatMap((r) => r.observations) };
    results.push(...(await this.research(subject, outcomes, this.researchBudget(budget))));

    const reconciled = reconcile(results.flatMap((r) => r.observations));
    const consolidated = await this.consolidator.consolidate(ref.entityType, reconciled, budget);
    const response = buildEnrichResponse(resolvedEntityId, ref, consolidated, results, outcomes);
    void this.history.record(response, ctx.correlationId);
    return response;
  }

  /** Research stops early enough to leave the consolidation its time. */
  private researchBudget(budget: CallBudget): CallBudget {
    if (!this.consolidator.isAvailable()) return budget;
    return { ...budget, deadline: budget.deadline - CONSOLIDATION_RESERVE_MS };
  }

  /** Research failures never fail the request: they only make the response partial. */
  private async research(subject: ResearchSubject, outcomes: ProviderOutcome[], budget: CallBudget): Promise<NamedEnrichResult[]> {
    const researchers: ResearchProvider[] = [];
    for (const researcher of this.researchers) {
      if (!researcher.canResearch(subject)) continue;
      if (researcher.isAvailable()) researchers.push(researcher);
      else outcomes.push(unavailableOutcome(researcher.name, 'not_configured'));
    }
    const calls = await callProviders(researchers, (researcher, options) => researcher.research(subject, options), budget);
    return collectEnrichResults(calls, outcomes);
  }

  /** Reports identifiers whose provider is not integrated yet (e.g. a DUNS number before D&B exists). */
  private unusableIdentifiers(ref: EntityRef): ProviderOutcome[] {
    const outcomes: ProviderOutcome[] = [];
    for (const { identifier, provider } of IDENTIFIER_OWNERS) {
      const integrated = this.providers.some((p) => p.name === provider);
      if (ref[identifier] !== null && !integrated) outcomes.push(unavailableOutcome(provider, 'not_integrated'));
    }
    return outcomes;
  }

  /** Returns the providers that can be called; the others are reported as unavailable. */
  private usableProviders(candidates: EnrichmentProvider[], outcomes: ProviderOutcome[]): EnrichmentProvider[] {
    const usable: EnrichmentProvider[] = [];
    for (const provider of candidates) {
      if (provider.isAvailable()) usable.push(provider);
      else outcomes.push(unavailableOutcome(provider.name, 'not_configured'));
    }
    if (usable.length === 0) throw noProviderAvailable(outcomes);
    return usable;
  }

  private budget(ctx: RequestContext, refresh = false): CallBudget {
    return {
      deadline: Date.now() + this.config.requestBudgetMs,
      signal: ctx.signal,
      correlationId: ctx.correlationId,
      cache: this.cache.scope(refresh, ctx.correlationId),
    };
  }
}

/** ZoomInfo and D&B results are cached by the provider's own identifier. */
async function lookup(provider: EnrichmentProvider, ref: EntityRef, options: ProviderCallOptions): Promise<ProviderEnrichResult> {
  const owner = IDENTIFIER_OWNERS.find((o) => o.provider === provider.name);
  const id = owner ? ref[owner.identifier] : null;
  if (id === null) return provider.enrich(ref, options);
  const entry = enrichResultEntry(provider.name, [ref.entityType, id]);
  return withFetchTime(await throughCache(options, entry, () => provider.enrich(ref, options)));
}

/** Records one outcome per call and returns the results of the providers that found the entity. */
function collectEnrichResults(calls: ProviderCall<ProviderEnrichResult>[], outcomes: ProviderOutcome[]): NamedEnrichResult[] {
  const results: NamedEnrichResult[] = [];
  for (const call of calls) {
    if (!call.ok) {
      outcomes.push(failedOutcome(call.provider, call.error.code));
      continue;
    }
    const retrievedAt = call.value.retrievedAt ?? call.retrievedAt;
    outcomes.push({ provider: call.provider, status: enrichStatus(call.value), error: null, retrievedAt });
    if (call.value.matched) results.push({ provider: call.provider, ...call.value });
  }
  return results;
}

function enrichStatus(result: ProviderEnrichResult): ProviderOutcome['status'] {
  if (!result.matched) return 'no_match';
  return result.complete ? 'ok' : 'partial';
}

function failedOutcome(provider: ProviderName, error: string): ProviderOutcome {
  return { provider, status: 'failed', error, retrievedAt: null };
}

function unavailableOutcome(provider: ProviderName, reason: string): ProviderOutcome {
  return { provider, status: 'unavailable', error: reason, retrievedAt: null };
}

function errorsOf(calls: ProviderCall<unknown>[]) {
  return calls.flatMap((call) => (call.ok ? [] : [call.error]));
}
