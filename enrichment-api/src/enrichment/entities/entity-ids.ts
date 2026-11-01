import { Inject, Injectable, Logger } from '@nestjs/common';
import { SnowflakeSqlError } from '../../snowflake/snowflake-sql.client.js';
import { entityStoreUnavailable, invalidRequest, unknownEntity } from '../enrichment.errors.js';
import type { IdentifyResponse, ProviderOutcome } from '../enrichment.types.js';
import type { RequestContext } from '../enrichment.service.js';
import { encodeEntityId, newStoredEntityId } from '../entity-id.js';
import type { EntityRef } from '../providers/provider.js';
import type { EnrichTarget } from '../validation.js';
import { ENTITY_TABLE, type EntityTable, type StoredEntity } from './entity-table.js';

type StoredTarget = Extract<EnrichTarget, { kind: 'stored' }>;

export interface ResolvedTarget {
  /** null when the provider IDs have no entity yet: one is created once a provider confirms them. */
  entityId: string | null;
  ref: EntityRef;
}

/**
 * Gives each company or person one internal entityId, mapped to its ZoomInfo ID and DUNS number. When two entities
 * turn out to be the same one, the newer one is retired and redirects to the older one, so no entityId ever breaks.
 * Without an entity table, the entityIds are stateless: they encode the provider IDs.
 */
@Injectable()
export class EntityIds {
  private readonly logger = new Logger(EntityIds.name);

  constructor(@Inject(ENTITY_TABLE) private readonly table: EntityTable) {}

  /** The entityId of a definite match; null otherwise, since ambiguous matches must not drive CRM updates. */
  async forIdentified(response: IdentifyResponse, ctx: RequestContext): Promise<string | null> {
    if (response.status !== 'matched') return null;
    const ref: EntityRef = { entityType: response.entityType, zoomInfoId: response.zoomInfoId, dunsNumber: response.dunsNumber };
    if (ref.zoomInfoId === null && ref.dunsNumber === null) return null;

    if (!this.table.isAvailable()) return encodeEntityId(ref);
    return this.withStore('identify', response.providers, ctx, () => this.resolve(ref, ctx));
  }

  /** Reads the entity to enrich, or the entity of the provider IDs, whose IDs fill the gaps of the request. */
  async forEnrich(target: EnrichTarget, ctx: RequestContext): Promise<ResolvedTarget> {
    if (target.kind === 'stored') return this.storedTarget(target, ctx);

    const ref = target.ref;
    if (!this.table.isAvailable()) return { entityId: encodeEntityId(ref), ref };
    const matches = await this.withStore('enrich', [], ctx, () => this.table.findByProviderIds(ref, ctx.signal));
    if (matches.length === 0) return { entityId: null, ref };

    const entity = oldestFirst(matches)[0];
    const filled: EntityRef = {
      entityType: ref.entityType,
      zoomInfoId: ref.zoomInfoId ?? entity.zoomInfoId,
      dunsNumber: ref.dunsNumber ?? entity.dunsNumber,
    };
    return { entityId: entity.entityId, ref: filled };
  }

  /** Finds or creates the entity of provider IDs that a provider confirmed. */
  register(ref: EntityRef, providers: ProviderOutcome[], ctx: RequestContext): Promise<string> {
    return this.withStore('register', providers, ctx, () => this.resolve(ref, ctx));
  }

  private async storedTarget(target: StoredTarget, ctx: RequestContext): Promise<ResolvedTarget> {
    if (!this.table.isAvailable()) throw entityStoreUnavailable([]);
    const entity = await this.withStore('enrich', [], ctx, () => this.findActive(target.entityId, ctx.signal));
    if (!entity || (entity.zoomInfoId === null && entity.dunsNumber === null)) throw unknownEntity();
    if (target.entityType && target.entityType !== entity.entityType) {
      throw invalidRequest([`entityType does not match entityId (${entity.entityType})`]);
    }
    const ref: EntityRef = { entityType: entity.entityType, zoomInfoId: entity.zoomInfoId, dunsNumber: entity.dunsNumber };
    return { entityId: entity.entityId, ref };
  }

  /** Follows the redirect of a retired entity. Redirects are one hop: a merge also moves the redirects to the loser. */
  private async findActive(entityId: string, signal: AbortSignal): Promise<StoredEntity | null> {
    const entity = await this.table.findById(entityId, signal);
    if (!entity?.mergedIntoId) return entity;
    return this.table.findById(entity.mergedIntoId, signal);
  }

  /** Concurrent requests for a new entity can each create one: the next resolve merges them. */
  private async resolve(ref: EntityRef, ctx: RequestContext): Promise<string> {
    const matches = await this.table.findByProviderIds(ref, ctx.signal);
    if (matches.length === 0) {
      const entityId = newStoredEntityId();
      await this.table.insert(entityId, ref, ctx.signal);
      return entityId;
    }

    const [survivor, ...duplicates] = oldestFirst(matches);
    for (const duplicate of duplicates) {
      await this.table.retire(duplicate.entityId, survivor.entityId, ctx.signal);
      const event = { event: 'entities.merged', entityId: duplicate.entityId, survivorId: survivor.entityId, correlationId: ctx.correlationId };
      this.logger.log(event);
    }

    if (hasNewIds(survivor, ref)) await this.table.setProviderIds(survivor.entityId, ref, ctx.signal);
    return survivor.entityId;
  }

  private async withStore<T>(operation: string, providers: ProviderOutcome[], ctx: RequestContext, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const event = { event: 'entities.store_failed', operation, ...describeError(error), correlationId: ctx.correlationId };
      this.logger.error(event);
      throw entityStoreUnavailable(providers);
    }
  }
}

/** The oldest entity survives a merge, since the CRM has had its ID the longest. */
function oldestFirst(entities: StoredEntity[]): StoredEntity[] {
  return [...entities].sort((a, b) => a.createdAtMs - b.createdAtMs || a.entityId.localeCompare(b.entityId));
}

function hasNewIds(entity: StoredEntity, ref: EntityRef): boolean {
  const newZoomInfoId = ref.zoomInfoId !== null && ref.zoomInfoId !== entity.zoomInfoId;
  const newDunsNumber = ref.dunsNumber !== null && ref.dunsNumber !== entity.dunsNumber;
  return newZoomInfoId || newDunsNumber;
}

function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof SnowflakeSqlError) return { status: error.status, code: error.code, detail: error.detail };
  return { detail: error instanceof Error ? error.message : String(error) };
}
