export type ZoomInfoErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'invalid_request'
  | 'auth_failed'
  | 'entitlement_missing'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'upstream_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response';

export interface ZoomInfoErrorDetails {
  operation?: string;
  status?: number;
  upstreamCode?: string;
  retryAfterMs?: number;
  retryable?: boolean;
}

/** Sanitized provider failure: never carries vendor bodies, credentials or tokens. */
export class ZoomInfoError extends Error {
  override readonly name = 'ZoomInfoError';

  constructor(
    readonly code: ZoomInfoErrorCode,
    readonly details: ZoomInfoErrorDetails = {},
  ) {
    const parts = [details.operation ?? 'zoominfo', code];
    if (details.status) parts.push(`HTTP ${details.status}`);
    if (details.upstreamCode) parts.push(details.upstreamCode);
    super(`ZoomInfo ${parts.join(' ')}`);
  }

  get retryable(): boolean {
    return this.details.retryable ?? false;
  }
}
