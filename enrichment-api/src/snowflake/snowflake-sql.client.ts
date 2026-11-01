import { snowflakeAuthHeaders, type SnowflakeConnection } from './snowflake-auth.js';

const STATEMENTS_PATH = '/api/v2/statements';
const STATEMENT_TIMEOUT_S = 15;
/** Enough of Snowflake's error message to diagnose a missing grant or object. */
const MAX_ERROR_DETAIL = 300;

export interface SnowflakeSqlConfig extends SnowflakeConnection {
  /** null uses the default warehouse of the user (or of the service). */
  warehouse: string | null;
}

/** One result row, keyed by column name as Snowflake returns it (uppercase unless quoted). */
export type SqlRow = Record<string, string | null>;

export class SnowflakeSqlError extends Error {
  override readonly name = 'SnowflakeSqlError';

  constructor(
    /** HTTP status; null when the request was not sent. */
    readonly status: number | null,
    readonly code: string | null,
    readonly detail: string,
  ) {
    super(`Snowflake SQL API error ${status ?? '-'} ${code ?? '-'}: ${detail}`);
  }
}

/** Runs single SQL statements through the Snowflake SQL API (optional storage). */
export class SnowflakeSqlClient {
  constructor(
    private readonly config: SnowflakeSqlConfig,
    private readonly fetchFn: typeof fetch,
  ) {}

  isAvailable(): boolean {
    return this.config.accountUrl !== null && this.config.auth !== null;
  }

  /** Every value is bound as TEXT to the `?` placeholders, in order. */
  async execute(statement: string, values: string[], signal: AbortSignal): Promise<SqlRow[]> {
    const { accountUrl, auth } = this.config;
    if (!accountUrl || !auth) throw new SnowflakeSqlError(null, null, 'not configured');
    const headers = await snowflakeAuthHeaders(auth);
    if (!headers) throw new SnowflakeSqlError(null, null, 'SPCS token file unreadable');

    const response = await this.fetchFn(accountUrl + STATEMENTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: JSON.stringify(this.requestBody(statement, values)),
      signal: AbortSignal.any([signal, AbortSignal.timeout((STATEMENT_TIMEOUT_S + 5) * 1000)]),
      redirect: 'error',
    });
    const body = parseJson(await response.text());
    // 202 means the statement is still running after the SQL API's own wait: too slow for a point query.
    if (response.status !== 200) {
      const detail = stringField(body, 'message') ?? `HTTP ${response.status}`;
      throw new SnowflakeSqlError(response.status, stringField(body, 'code'), detail.slice(0, MAX_ERROR_DETAIL));
    }
    return readRows(body);
  }

  private requestBody(statement: string, values: string[]): Record<string, unknown> {
    const body: Record<string, unknown> = { statement, timeout: STATEMENT_TIMEOUT_S };
    if (this.config.warehouse) body.warehouse = this.config.warehouse;
    if (values.length > 0) {
      const bindings: Record<string, { type: 'TEXT'; value: string }> = {};
      for (const [index, value] of values.entries()) {
        bindings[String(index + 1)] = { type: 'TEXT', value };
      }
      body.bindings = bindings;
    }
    return body;
  }
}

function readRows(body: unknown): SqlRow[] {
  const rowType = isRecord(body) && isRecord(body.resultSetMetaData) ? body.resultSetMetaData.rowType : undefined;
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(rowType) || !Array.isArray(data)) throw new SnowflakeSqlError(200, null, 'malformed response');

  const columns = rowType.map((column) => (isRecord(column) && typeof column.name === 'string' ? column.name : ''));
  const rows: SqlRow[] = [];
  for (const values of data) {
    if (!Array.isArray(values)) throw new SnowflakeSqlError(200, null, 'malformed response');
    const row: SqlRow = {};
    for (const [index, column] of columns.entries()) {
      const value: unknown = values[index];
      row[column] = typeof value === 'string' ? value : null;
    }
    rows.push(row);
  }
  return rows;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function stringField(body: unknown, field: string): string | null {
  if (!isRecord(body)) return null;
  const value = body[field];
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
