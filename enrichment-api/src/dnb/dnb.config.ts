export const DNB_CONFIG = Symbol('DNB_CONFIG');
export const DNB_FETCH = Symbol('DNB_FETCH');

export interface DnbConfig {
  enabled: boolean;
  credentials: { clientId: string; clientSecret: string } | null;
  baseUrl: string;
  /** The D&B Connect source that defines which data the matchEnrich call returns. */
  matchSource: string;
  /** Time limit of one D&B call, within the caller's deadline. */
  requestTimeoutMs: number;
}

type Env = Record<string, string | undefined>;

const DEFAULT_BASE_URL = 'https://plus.dnb.com';
const DEFAULT_MATCH_SOURCE = 'Source_3d5hz4ae';
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export function loadDnbConfig(env: Env = process.env): DnbConfig {
  const clientId = env.DNB_CLIENT_ID?.trim();
  const clientSecret = env.DNB_CLIENT_SECRET?.trim();
  let baseUrl = env.DNB_BASE_URL?.trim() || DEFAULT_BASE_URL;
  while (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  if (!/^https:\/\/[^\s/]+$/.test(baseUrl)) throw new Error('DNB_BASE_URL must be an https origin such as https://plus.dnb.com');
  const matchSource = env.DNB_MATCH_SOURCE?.trim() || DEFAULT_MATCH_SOURCE;
  if (!/^\w+$/.test(matchSource)) throw new Error('DNB_MATCH_SOURCE must be a D&B Connect source ID such as Source_3d5hz4ae');

  return {
    enabled: readBoolean(env, 'DNB_ENABLED', true),
    credentials: clientId && clientSecret ? { clientId, clientSecret } : null,
    baseUrl,
    matchSource,
    requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
  };
}

function readBoolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['true', '1', 'yes'].includes(raw)) return true;
  if (['false', '0', 'no'].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}
