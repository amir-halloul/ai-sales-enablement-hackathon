import { loadSnowflakeConnection } from './snowflake-auth.js';
import type { SnowflakeSqlConfig } from './snowflake-sql.client.js';

/** The fetch used by the tables the service keeps in Snowflake; tests replace it. */
export const SNOWFLAKE_SQL_FETCH = Symbol('SNOWFLAKE_SQL_FETCH');

type Env = Record<string, string | undefined>;

const IDENTIFIER = '[A-Za-z_][A-Za-z0-9_$]*';
const QUALIFIED_NAME_PATTERN = new RegExp(`^${IDENTIFIER}\\.${IDENTIFIER}\\.${IDENTIFIER}$`);
const IDENTIFIER_PATTERN = new RegExp(`^${IDENTIFIER}$`);

/** The connection and warehouse shared by the entity, cache and history tables. */
export function loadSnowflakeSqlConfig(env: Env): SnowflakeSqlConfig {
  const warehouse = env.SNOWFLAKE_WAREHOUSE?.trim() || null;
  if (warehouse && !IDENTIFIER_PATTERN.test(warehouse)) {
    throw new Error('SNOWFLAKE_WAREHOUSE must be a warehouse name such as MY_WH');
  }
  return { warehouse, ...loadSnowflakeConnection(env) };
}

/** Reads an optional table name, which becomes part of the SQL text, so it must be plain identifiers. */
export function readTableName(env: Env, variable: string, config: SnowflakeSqlConfig): string | null {
  const table = env[variable]?.trim() || null;
  if (!table) return null;
  if (!QUALIFIED_NAME_PATTERN.test(table)) {
    throw new Error(`${variable} must be a fully qualified table name such as MY_DB.MY_SCHEMA.MY_TABLE`);
  }
  if (!config.accountUrl || !config.auth) {
    throw new Error(`${variable} needs a Snowflake connection: SNOWFLAKE_ACCOUNT_URL and SNOWFLAKE_PAT, or SPCS`);
  }
  return table;
}
