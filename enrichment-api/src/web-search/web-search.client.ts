import { Inject, Injectable, Logger } from '@nestjs/common';
import { openAiAuthHeaders } from '../openai/openai.config.js';
import { WEB_SEARCH_CONFIG, WEB_SEARCH_FETCH, type WebSearchConfig } from './web-search.config.js';
import { WebSearchError } from './web-search.errors.js';

const RESPONSES_PATH = '/responses';
const MODELS_PATH = '/models/';
const WEB_SEARCH_TOOL = 'web_search';
const URL_PATTERN = /https?:\/\/[^\s"'<>()[\]{}]+/g;
/** Enough of OpenAI's error message to diagnose a bad key or an unsupported model. */
const MAX_ERROR_DETAIL = 500;

export interface WebSearchRequest {
  /** Short label for logs and errors, e.g. the prompt name. */
  operation: string;
  instructions: string;
  input: string;
  /** JSON schema the answer must follow. It is part of the prompt, not enforced. */
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface WebSearchCallOptions {
  /** Absolute deadline (epoch ms). */
  deadline: number;
  signal?: AbortSignal;
  correlationId?: string;
}

export interface WebSearchAnswer {
  /** The model's JSON answer, shaped by the request schema. */
  output: unknown;
  /** Every page the search tool returned or opened, keyed by sourceKey(url). */
  sources: Map<string, string>;
  usage: { searches: number; inputTokens?: number; outputTokens?: number };
}

type LogFields = Record<string, string | number | undefined>;

/** Asks an OpenAI model with the hosted web_search tool, through the Responses REST API. */
@Injectable()
export class WebSearchClient {
  private readonly logger = new Logger('WebSearch');

  constructor(
    @Inject(WEB_SEARCH_CONFIG) private readonly config: WebSearchConfig,
    @Inject(WEB_SEARCH_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  isAvailable(): boolean {
    return this.config.enabled && this.config.apiKey !== null;
  }

  get model(): string {
    return this.config.model;
  }

  async search(request: WebSearchRequest, options: WebSearchCallOptions): Promise<WebSearchAnswer> {
    const { operation } = request;
    const { baseUrl, apiKey } = this.config;
    if (!this.config.enabled) throw new WebSearchError('disabled', { operation });
    if (!apiKey) throw new WebSearchError('not_configured', { operation });
    if (options.signal?.aborted) throw new WebSearchError('cancelled', { operation });
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new WebSearchError('timeout', { operation });

    const timeout = AbortSignal.timeout(remaining);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const started = Date.now();
    try {
      const response = await this.fetchFn(baseUrl + RESPONSES_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...openAiAuthHeaders(apiKey),
        },
        body: JSON.stringify(this.requestBody(request)),
        signal,
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, MAX_ERROR_DETAIL);
        this.log('warn', 'http_error', { operation, status: response.status, detail, correlationId: options.correlationId });
        throw httpError(response, operation);
      }
      const answer = readAnswer(parseJson(await response.text(), operation), operation);
      this.log('debug', 'request_ok', {
        operation,
        durationMs: Date.now() - started,
        searches: answer.usage.searches,
        inputTokens: answer.usage.inputTokens,
        outputTokens: answer.usage.outputTokens,
        correlationId: options.correlationId,
      });
      return answer;
    } catch (error) {
      const err = error instanceof WebSearchError ? error : abortOrNetworkError(operation, options, timeout);
      this.log('warn', 'request_failed', {
        operation,
        code: err.code,
        status: err.details.status,
        durationMs: Date.now() - started,
        correlationId: options.correlationId,
      });
      throw err;
    }
  }

  /** Checks that OpenAI accepts our key and knows the model, without running it (no tokens used). */
  async ping(options: WebSearchCallOptions): Promise<void> {
    const operation = 'ping';
    const { baseUrl, apiKey, model } = this.config;
    if (!this.config.enabled) throw new WebSearchError('disabled', { operation });
    if (!apiKey) throw new WebSearchError('not_configured', { operation });
    const timeout = AbortSignal.timeout(Math.max(1, options.deadline - Date.now()));

    let response: Response;
    try {
      response = await this.fetchFn(baseUrl + MODELS_PATH + encodeURIComponent(model), {
        method: 'GET',
        headers: { accept: 'application/json', ...openAiAuthHeaders(apiKey) },
        signal: timeout,
        redirect: 'error',
      });
    } catch {
      throw abortOrNetworkError(operation, options, timeout);
    }
    if (response.ok) {
      await response.body?.cancel();
      return;
    }
    const detail = (await response.text()).slice(0, MAX_ERROR_DETAIL);
    this.log('warn', 'http_error', { operation, status: response.status, detail });
    throw httpError(response, operation);
  }

  private requestBody(request: WebSearchRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      instructions: request.instructions,
      input: `${request.input}\n\n${jsonFormatRule(request.schemaName, request.schema)}`,
      tools: [{ type: WEB_SEARCH_TOOL }],
      // Every page the search consulted, not only the ones the answer cites.
      include: ['web_search_call.action.sources'],
      store: false,
    };
    if (this.config.reasoningEffort) body.reasoning = { effort: this.config.reasoningEffort };
    return body;
  }

  private log(level: 'debug' | 'warn', event: string, fields: LogFields): void {
    this.logger[level]({ event: `websearch.${event}`, ...fields });
  }
}

/** Returns the search result the model cited, or undefined when the URL is not one of the results. */
export function citedSource(answer: WebSearchAnswer, url: unknown): string | undefined {
  if (typeof url !== 'string') return undefined;
  const key = sourceKey(url);
  return key === undefined ? undefined : answer.sources.get(key);
}

/** Compares URLs loosely: the scheme, "www.", the fragment and a trailing slash do not matter. */
export function sourceKey(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
  const host = parsed.hostname.replace(/^www\./, '');
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${host}${path}${parsed.search}`;
}

function jsonFormatRule(schemaName: string, schema: Record<string, unknown>): string {
  return [
    'Answer with a single JSON object and nothing else: no markdown, no code fences, no explanation.',
    `The JSON object must follow the JSON schema "${schemaName}":`,
    JSON.stringify(schema),
  ].join('\n');
}

/** Reads the Responses API result: the web search sources, the final text answer and the token usage. */
function readAnswer(body: unknown, operation: string): WebSearchAnswer {
  if (!isRecord(body) || !Array.isArray(body.output)) throw new WebSearchError('malformed_response', { operation });
  if (body.status === 'cancelled') throw new WebSearchError('cancelled', { operation });
  if (body.status === 'failed') throw new WebSearchError('upstream_unavailable', { operation });
  if (body.status === 'incomplete') throw new WebSearchError('malformed_response', { operation });

  const sources = new Map<string, string>();
  let searches = 0;
  let text: string | undefined;
  for (const item of body.output) {
    if (!isRecord(item)) continue;
    if (item.type === 'web_search_call') {
      if (!isRecord(item.action) || item.action.type === 'search') searches++;
      addUrls(item.action, sources);
    }
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part) || part.type !== 'output_text' || typeof part.text !== 'string') continue;
        // The model may write progress notes before the answer: the last text block is the answer.
        text = part.text;
        addUrls(part.annotations, sources);
      }
    }
  }
  if (text === undefined) throw new WebSearchError('malformed_response', { operation });

  return { output: parseJson(jsonObjectIn(text), operation), sources, usage: { searches, ...tokenUsage(body.usage) } };
}

/** Every URL found anywhere in a search action or a citation counts as a source. */
function addUrls(value: unknown, sources: Map<string, string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(URL_PATTERN)) addSource(match[0].replace(/[.,;:!?]+$/, ''), sources);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addUrls(item, sources);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) addUrls(item, sources);
  }
}

function addSource(url: string, sources: Map<string, string>): void {
  const key = sourceKey(url);
  if (key !== undefined && !sources.has(key)) sources.set(key, url);
}

/** Tolerates code fences or a sentence around the JSON object. */
function jsonObjectIn(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start === -1 || end < start ? text : text.slice(start, end + 1);
}

function tokenUsage(usage: unknown): { inputTokens?: number; outputTokens?: number } {
  if (!isRecord(usage) || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return {};
  return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
}

function httpError(response: Response, operation: string): WebSearchError {
  const { status } = response;
  if (status === 429) return new WebSearchError('rate_limited', { operation, status });
  if (status >= 500 || status === 408) return new WebSearchError('upstream_unavailable', { operation, status });
  if (status === 401 || status === 403) return new WebSearchError('auth_failed', { operation, status });
  return new WebSearchError('invalid_request', { operation, status });
}

function abortOrNetworkError(operation: string, options: WebSearchCallOptions, timeout: AbortSignal): WebSearchError {
  if (options.signal?.aborted) return new WebSearchError('cancelled', { operation });
  if (timeout.aborted) return new WebSearchError('timeout', { operation });
  return new WebSearchError('upstream_unavailable', { operation });
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebSearchError('malformed_response', { operation });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
