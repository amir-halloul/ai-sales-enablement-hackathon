import type { EntityType } from '../enrichment.types.js';
import type { EntityRef } from '../providers/provider.js';

export const ENTITY_TABLE = Symbol('ENTITY_TABLE');

export interface StoredEntity {
  entityId: string;
  entityType: EntityType;
  zoomInfoId: string | null;
  dunsNumber: string | null;
  /** Set on a duplicate: its provider IDs moved to this entity. */
  mergedIntoId: string | null;
  createdAtMs: number;
}

/**
 * The internal entity IDs and their provider IDs. Concurrent requests can store a provider ID on two entities:
 * the next lookup finds both and merges them.
 */
export interface EntityTable {
  isAvailable(): boolean;
  findById(entityId: string, signal: AbortSignal): Promise<StoredEntity | null>;
  /** The entities that have the ZoomInfo ID or the DUNS number of the reference. */
  findByProviderIds(ref: EntityRef, signal: AbortSignal): Promise<StoredEntity[]>;
  insert(entityId: string, ref: EntityRef, signal: AbortSignal): Promise<void>;
  /** Sets the provider IDs that the reference has. */
  setProviderIds(entityId: string, ref: EntityRef, signal: AbortSignal): Promise<void>;
  /** Clears the entity's provider IDs and redirects it, and the entities redirected to it, to the survivor. */
  retire(entityId: string, survivorId: string, signal: AbortSignal): Promise<void>;
}
