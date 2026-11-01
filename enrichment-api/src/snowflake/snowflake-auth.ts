import { readFile } from 'node:fs/promises';

/** Inside Snowpark Container Services, Snowflake keeps a short-lived OAuth token for the service in this file. */
export const SPCS_TOKEN_FILE = '/snowflake/session/token';

export type SnowflakeAuth = { type: 'pat'; token: string } | { type: 'spcs'; tokenFile: string };

export interface SnowflakeConnection {
  /** Snowflake account URL, e.g. https://myorg-myaccount.snowflakecomputing.com */
  accountUrl: string | null;
  auth: SnowflakeAuth | null;
}

type Env = Record<string, string | undefined>;

/**
 * Locally: SNOWFLAKE_ACCOUNT_URL + SNOWFLAKE_PAT (programmatic access token).
 * In SPCS: Snowflake sets SNOWFLAKE_HOST and provides the token file.
 */
export function loadSnowflakeConnection(env: Env = process.env): SnowflakeConnection {
  const pat = env.SNOWFLAKE_PAT?.trim();
  const spcsHost = env.SNOWFLAKE_HOST?.trim();

  let accountUrl = env.SNOWFLAKE_ACCOUNT_URL?.trim().replace(/\/+$/, '') || null;
  if (!accountUrl && spcsHost) accountUrl = `https://${spcsHost}`;
  if (accountUrl && !/^https:\/\/[a-z0-9._-]+$/i.test(accountUrl)) {
    throw new Error('SNOWFLAKE_ACCOUNT_URL must be an https URL such as https://myorg-myaccount.snowflakecomputing.com');
  }

  let auth: SnowflakeAuth | null = null;
  if (pat) auth = { type: 'pat', token: pat };
  else if (spcsHost) auth = { type: 'spcs', tokenFile: SPCS_TOKEN_FILE };

  return { accountUrl, auth };
}

/** Returns null when the SPCS token file cannot be read. */
export async function snowflakeAuthHeaders(auth: SnowflakeAuth): Promise<Record<string, string> | null> {
  if (auth.type === 'pat') {
    return { authorization: `Bearer ${auth.token}`, 'x-snowflake-authorization-token-type': 'PROGRAMMATIC_ACCESS_TOKEN' };
  }
  let token: string;
  try {
    // Re-read on every call: Snowflake refreshes the file before the token expires.
    token = (await readFile(auth.tokenFile, 'utf8')).trim();
  } catch {
    return null;
  }
  return { authorization: `Bearer ${token}`, 'x-snowflake-authorization-token-type': 'OAUTH' };
}
