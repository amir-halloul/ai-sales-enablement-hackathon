export type WebSearchErrorCode =
  | 'disabled'
  | 'not_configured'
  | 'invalid_request'
  | 'auth_failed'
  | 'rate_limited'
  | 'upstream_unavailable'
  | 'timeout'
  | 'cancelled'
  | 'malformed_response';

export interface WebSearchErrorDetails {
  operation?: string;
  status?: number;
}

/** Sanitized web search failure: never carries prompts, model output or credentials. */
export class WebSearchError extends Error {
  override readonly name = 'WebSearchError';

  constructor(
    readonly code: WebSearchErrorCode,
    readonly details: WebSearchErrorDetails = {},
  ) {
    const parts = [details.operation ?? 'web_search', code];
    if (details.status) parts.push(`HTTP ${details.status}`);
    super(`Web search ${parts.join(' ')}`);
  }
}
