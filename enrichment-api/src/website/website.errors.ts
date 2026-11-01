export type WebsiteErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'invalid_request'
  | 'auth_failed'
  | 'blocked'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response';

export interface WebsiteErrorDetails {
  operation?: string;
  status?: number;
}

/** Sanitized website crawl or extraction failure: never carries page content, model output or credentials. */
export class WebsiteError extends Error {
  override readonly name = 'WebsiteError';

  constructor(
    readonly code: WebsiteErrorCode,
    readonly details: WebsiteErrorDetails = {},
  ) {
    const parts = [details.operation ?? 'website', code];
    if (details.status) parts.push(`HTTP ${details.status}`);
    super(`Website ${parts.join(' ')}`);
  }
}
