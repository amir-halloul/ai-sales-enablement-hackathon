import type { EntityRef } from '../providers/provider.js';
import type { EntityTable, StoredEntity } from './entity-table.js';

/** The entity table in memory. For tests. */
export class InMemoryEntityTable implements EntityTable {
  readonly rows: StoredEntity[] = [];
  /** false emulates a deployment without an entity table. */
  available = true;
  private clock = 0;

  isAvailable(): boolean {
    return this.available;
  }

  findById(entityId: string): Promise<StoredEntity | null> {
    const row = this.rows.find((r) => r.entityId === entityId);
    return Promise.resolve(row ? { ...row } : null);
  }

  findByProviderIds(ref: EntityRef): Promise<StoredEntity[]> {
    const matches = this.rows.filter((r) => r.entityType === ref.entityType && sharesProviderId(r, ref));
    return Promise.resolve(matches.map((r) => ({ ...r })));
  }

  insert(entityId: string, ref: EntityRef): Promise<void> {
    // A counter instead of the time, so the creation order is never a tie.
    this.clock += 1;
    this.rows.push({ entityId, ...ref, mergedIntoId: null, createdAtMs: this.clock });
    return Promise.resolve();
  }

  setProviderIds(entityId: string, ref: EntityRef): Promise<void> {
    const row = this.rows.find((r) => r.entityId === entityId);
    if (!row) return Promise.resolve();
    if (ref.zoomInfoId !== null) row.zoomInfoId = ref.zoomInfoId;
    if (ref.dunsNumber !== null) row.dunsNumber = ref.dunsNumber;
    return Promise.resolve();
  }

  retire(entityId: string, survivorId: string): Promise<void> {
    for (const row of this.rows) {
      if (row.entityId === entityId) {
        row.zoomInfoId = null;
        row.dunsNumber = null;
        row.mergedIntoId = survivorId;
      }
      if (row.mergedIntoId === entityId) row.mergedIntoId = survivorId;
    }
    return Promise.resolve();
  }
}

function sharesProviderId(row: StoredEntity, ref: EntityRef): boolean {
  const sameZoomInfo = ref.zoomInfoId !== null && row.zoomInfoId === ref.zoomInfoId;
  const sameDuns = ref.dunsNumber !== null && row.dunsNumber === ref.dunsNumber;
  return sameZoomInfo || sameDuns;
}
