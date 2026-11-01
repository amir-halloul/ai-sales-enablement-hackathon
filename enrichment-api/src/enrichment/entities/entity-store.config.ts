import type { SnowflakeSqlConfig } from '../../snowflake/snowflake-sql.client.js';
import { loadSnowflakeSqlConfig, readTableName } from '../../snowflake/snowflake-sql.config.js';

export const ENTITY_STORE_CONFIG = Symbol('ENTITY_STORE_CONFIG');

export interface EntityStoreConfig extends SnowflakeSqlConfig {
  /** Fully qualified name of the hybrid table; null keeps the stateless entity IDs. */
  table: string | null;
}

export function loadEntityStoreConfig(env: Record<string, string | undefined> = process.env): EntityStoreConfig {
  const sql = loadSnowflakeSqlConfig(env);
  return { ...sql, table: readTableName(env, 'ENTITY_STORE_TABLE', sql) };
}
