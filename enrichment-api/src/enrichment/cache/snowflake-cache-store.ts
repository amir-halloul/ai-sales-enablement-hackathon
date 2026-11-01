import { Inject, Injectable } from '@nestjs/common';
import { SnowflakeSqlClient, SnowflakeSqlError } from '../../snowflake/snowflake-sql.client.js';
import { SNOWFLAKE_SQL_FETCH } from '../../snowflake/snowflake-sql.config.js';
import { CACHE_CONFIG, type CacheConfig } from './cache.config.js';
import type { CacheStore, StoredValue } from './source-cache.js';

/** The cache as a standard Snowflake table (see infra/snowflake/cache-tables.sql). */
@Injectable()
export class SnowflakeCacheStore implements CacheStore {
  private readonly sql: SnowflakeSqlClient;

  constructor(
    @Inject(CACHE_CONFIG) private readonly config: CacheConfig,
    @Inject(SNOWFLAKE_SQL_FETCH) fetchFn: typeof fetch,
  ) {
    this.sql = new SnowflakeSqlClient(config, fetchFn);
  }

  isAvailable(): boolean {
    return this.config.table !== null && this.sql.isAvailable();
  }

  async read(key: string, signal: AbortSignal): Promise<StoredValue | null> {
    const statement =
      `SELECT RESULT, DATE_PART(EPOCH_MILLISECOND, FETCHED_AT) AS FETCHED_MS FROM ${this.table()} ` +
      'WHERE CACHE_KEY = ? ORDER BY FETCHED_AT DESC LIMIT 1';
    const rows = await this.sql.execute(statement, [key], signal);
    if (rows.length === 0) return null;

    const fetchedAtMs = Number(rows[0].FETCHED_MS);
    if (!rows[0].RESULT || !Number.isFinite(fetchedAtMs)) throw new SnowflakeSqlError(200, null, 'unexpected cache row');
    return { value: JSON.parse(rows[0].RESULT) as unknown, fetchedAtMs };
  }

  async write(key: string, source: string, value: unknown, signal: AbortSignal): Promise<void> {
    // PARSE_JSON is not allowed in a VALUES clause, hence the subquery.
    const statement =
      `MERGE INTO ${this.table()} t USING (SELECT ? AS CACHE_KEY, ? AS SOURCE, PARSE_JSON(?) AS RESULT) s ` +
      'ON t.CACHE_KEY = s.CACHE_KEY ' +
      'WHEN MATCHED THEN UPDATE SET t.SOURCE = s.SOURCE, t.RESULT = s.RESULT, t.FETCHED_AT = SYSDATE() ' +
      'WHEN NOT MATCHED THEN INSERT (CACHE_KEY, SOURCE, RESULT, FETCHED_AT) VALUES (s.CACHE_KEY, s.SOURCE, s.RESULT, SYSDATE())';
    await this.sql.execute(statement, [key, source, JSON.stringify(value)], signal);
  }

  private table(): string {
    if (!this.config.table) throw new SnowflakeSqlError(null, null, 'SOURCE_CACHE_TABLE is not set');
    return this.config.table;
  }
}
