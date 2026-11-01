import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { SnowflakeSqlClient, type SnowflakeSqlConfig } from '../../snowflake/snowflake-sql.client.js';
import { loadSnowflakeSqlConfig, readTableName, SNOWFLAKE_SQL_FETCH } from '../../snowflake/snowflake-sql.config.js';
import type { EnrichResponse } from '../enrichment.types.js';

export const HISTORY_CONFIG = Symbol('HISTORY_CONFIG');

export interface HistoryConfig extends SnowflakeSqlConfig {
  /** Fully qualified name of the history table; null turns the history off. */
  table: string | null;
}

/** Writes run after the response is sent, so they get their own time limit. */
const WRITE_TIMEOUT_MS = 20_000;
/** Request metadata: a change in these alone is not a change of the entity. */
const METADATA_FIELDS = ['completeness', 'warnings', 'providers', 'retrievedAt'];

export function loadHistoryConfig(env: Record<string, string | undefined> = process.env): HistoryConfig {
  const sql = loadSnowflakeSqlConfig(env);
  return { ...sql, table: readTableName(env, 'ENRICHMENT_HISTORY_TABLE', sql) };
}

/** Keeps a snapshot of each enrichment response whose content differs from the entity's previous snapshot. */
@Injectable()
export class EnrichmentHistory {
  private readonly logger = new Logger('EnrichmentHistory');
  private readonly sql: SnowflakeSqlClient;

  constructor(
    @Inject(HISTORY_CONFIG) private readonly config: HistoryConfig,
    @Inject(SNOWFLAKE_SQL_FETCH) fetchFn: typeof fetch,
  ) {
    this.sql = new SnowflakeSqlClient(config, fetchFn);
  }

  /**
   * Never fails. Responses where a provider failed are skipped: their missing data is not a change.
   * The insert and the comparison with the last snapshot are one statement.
   */
  async record(response: EnrichResponse, correlationId: string): Promise<void> {
    const table = this.config.table;
    if (!table || !this.sql.isAvailable()) return;
    if (response.providers.some((provider) => provider.status === 'failed')) return;

    const hash = contentHash(response);
    const statement =
      `INSERT INTO ${table} (ENTITY_ID, ENTITY_TYPE, CONTENT_HASH, RESPONSE, CREATED_AT) ` +
      'SELECT ?, ?, ?, PARSE_JSON(?), SYSDATE() ' +
      `FROM (SELECT MAX_BY(CONTENT_HASH, CREATED_AT) AS LAST_HASH FROM ${table} WHERE ENTITY_ID = ?) ` +
      'WHERE LAST_HASH IS DISTINCT FROM ?';
    const values = [response.entityId, response.entityType, hash, JSON.stringify(response), response.entityId, hash];
    try {
      await this.sql.execute(statement, values, AbortSignal.timeout(WRITE_TIMEOUT_MS));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn({ event: 'history.write_failed', correlationId, detail });
    }
  }
}

function contentHash(response: EnrichResponse): string {
  const content: Record<string, unknown> = { ...response };
  for (const field of METADATA_FIELDS) delete content[field];
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}
