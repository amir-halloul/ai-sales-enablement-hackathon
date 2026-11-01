export type DnbErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'invalid_request'
  | 'auth_failed'
  | 'entitlement_missing'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response';

export interface DnbErrorDetails {
  operation?: string;
  status?: number;
  /** D&B's error code, e.g. CONNECT_001. */
  upstreamCode?: string;
  retryAfterMs?: number;
}

/** Sanitized D&B failure: never carries response bodies, credentials or tokens. */
export class DnbError extends Error {
  override readonly name = 'DnbError';

  constructor(
    readonly code: DnbErrorCode,
    readonly details: DnbErrorDetails = {},
  ) {
    const parts = [details.operation ?? 'dnb', code];
    if (details.status) parts.push(`HTTP ${details.status}`);
    if (details.upstreamCode) parts.push(details.upstreamCode);
    super(`D&B ${parts.join(' ')}`);
  }
}
