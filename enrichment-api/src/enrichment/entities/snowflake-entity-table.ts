import { Inject, Injectable } from '@nestjs/common';
import { SnowflakeSqlClient, SnowflakeSqlError, type SqlRow } from '../../snowflake/snowflake-sql.client.js';
import { SNOWFLAKE_SQL_FETCH } from '../../snowflake/snowflake-sql.config.js';
import type { EntityRef } from '../providers/provider.js';
import { ENTITY_STORE_CONFIG, type EntityStoreConfig } from './entity-store.config.js';
import type { EntityTable, StoredEntity } from './entity-table.js';

const COLUMNS = 'ENTITY_ID, ENTITY_TYPE, ZOOMINFO_ID, DUNS, MERGED_INTO_ID, DATE_PART(EPOCH_MILLISECOND, CREATED_AT) AS CREATED_MS';

/** The entity table as a Snowflake hybrid table (see infra/snowflake/entity-table.sql). */
@Injectable()
export class SnowflakeEntityTable implements EntityTable {
  private readonly sql: SnowflakeSqlClient;

  constructor(
    @Inject(ENTITY_STORE_CONFIG) private readonly config: EntityStoreConfig,
    @Inject(SNOWFLAKE_SQL_FETCH) fetchFn: typeof fetch,
  ) {
    this.sql = new SnowflakeSqlClient(config, fetchFn);
  }

  isAvailable(): boolean {
    return this.config.table !== null && this.sql.isAvailable();
  }

  async findById(entityId: string, signal: AbortSignal): Promise<StoredEntity | null> {
    const rows = await this.sql.execute(`SELECT ${COLUMNS} FROM ${this.table()} WHERE ENTITY_ID = ?`, [entityId], signal);
    return rows.length > 0 ? toEntity(rows[0]) : null;
  }

  async findByProviderIds(ref: EntityRef, signal: AbortSignal): Promise<StoredEntity[]> {
    const conditions: string[] = [];
    const values: string[] = [ref.entityType];
    if (ref.zoomInfoId !== null) {
      conditions.push('ZOOMINFO_ID = ?');
      values.push(ref.zoomInfoId);
    }
    if (ref.dunsNumber !== null) {
      conditions.push('DUNS = ?');
      values.push(ref.dunsNumber);
    }
    if (conditions.length === 0) return [];

    const statement = `SELECT ${COLUMNS} FROM ${this.table()} WHERE ENTITY_TYPE = ? AND (${conditions.join(' OR ')})`;
    const rows = await this.sql.execute(statement, values, signal);
    return rows.map(toEntity);
  }

  async insert(entityId: string, ref: EntityRef, signal: AbortSignal): Promise<void> {
    // NULLIF turns '' into NULL: the SQL API binds text values only.
    const statement =
      `INSERT INTO ${this.table()} (ENTITY_ID, ENTITY_TYPE, ZOOMINFO_ID, DUNS, CREATED_AT) ` +
      'VALUES (?, ?, NULLIF(?, \'\'), NULLIF(?, \'\'), SYSDATE())';
    const values = [entityId, ref.entityType, ref.zoomInfoId ?? '', ref.dunsNumber ?? ''];
    await this.sql.execute(statement, values, signal);
  }

  async setProviderIds(entityId: string, ref: EntityRef, signal: AbortSignal): Promise<void> {
    const assignments: string[] = [];
    const values: string[] = [];
    if (ref.zoomInfoId !== null) {
      assignments.push('ZOOMINFO_ID = ?');
      values.push(ref.zoomInfoId);
    }
    if (ref.dunsNumber !== null) {
      assignments.push('DUNS = ?');
      values.push(ref.dunsNumber);
    }
    if (assignments.length === 0) return;

    const statement = `UPDATE ${this.table()} SET ${assignments.join(', ')} WHERE ENTITY_ID = ?`;
    await this.sql.execute(statement, [...values, entityId], signal);
  }

  async retire(entityId: string, survivorId: string, signal: AbortSignal): Promise<void> {
    // No transaction: the SQL API can't bind values in multi-statement requests. Each step leaves a valid
    // state, and the next Identify of the entity re-attaches any ID that a failure left missing.
    await this.sql.execute(
      `UPDATE ${this.table()} SET ZOOMINFO_ID = NULL, DUNS = NULL, MERGED_INTO_ID = ? WHERE ENTITY_ID = ?`,
      [survivorId, entityId],
      signal,
    );
    await this.sql.execute(`UPDATE ${this.table()} SET MERGED_INTO_ID = ? WHERE MERGED_INTO_ID = ?`, [survivorId, entityId], signal);
  }

  private table(): string {
    if (!this.config.table) throw new SnowflakeSqlError(null, null, 'ENTITY_STORE_TABLE is not set');
    return this.config.table;
  }
}

function toEntity(row: SqlRow): StoredEntity {
  const entityType = row.ENTITY_TYPE;
  const createdAtMs = Number(row.CREATED_MS);
  if (!row.ENTITY_ID || (entityType !== 'company' && entityType !== 'person') || !Number.isFinite(createdAtMs)) {
    throw new SnowflakeSqlError(200, null, 'unexpected entity row');
  }
  return {
    entityId: row.ENTITY_ID,
    entityType,
    zoomInfoId: row.ZOOMINFO_ID,
    dunsNumber: row.DUNS,
    mergedIntoId: row.MERGED_INTO_ID,
    createdAtMs,
  };
}
