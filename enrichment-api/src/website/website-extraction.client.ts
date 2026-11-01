import { Inject, Injectable, Logger } from '@nestjs/common';
import { openAiAuthHeaders } from '../openai/openai.config.js';
import { WEBSITE_CONFIG, WEBSITE_OPENAI_FETCH, type WebsiteConfig } from './website.config.js';
import { WebsiteError } from './website.errors.js';

const CHAT_COMPLETIONS_PATH = '/chat/completions';
const MAX_COMPLETION_TOKENS = 8_192;
/** Enough of OpenAI's error message to diagnose a bad key or an unsupported model. */
const MAX_ERROR_DETAIL = 500;

export interface ExtractionRequest {
  /** Short label for logs and errors. */
  operation: string;
  instructions: string;
  input: string;
  schemaName: string;
  /** JSON schema that OpenAI applies to the answer (structured output). */
  schema: Record<string, unknown>;
}

export interface ExtractionCallOptions {
  /** Absolute deadline (epoch ms). */
  deadline: number;
  signal: AbortSignal;
  correlationId?: string;
}

export interface ExtractionAnswer {
  /** The model's JSON answer, shaped by the request schema. */
  output: unknown;
  usage: { inputTokens?: number; outputTokens?: number };
}

type LogFields = Record<string, string | number | undefined>;

/** What the client needs; the list consolidation reuses the client with its own switch and model. */
export type ExtractionConfig = Pick<WebsiteConfig, 'enabled' | 'model' | 'baseUrl' | 'apiKey' | 'reasoningEffort'>;

/** Asks an OpenAI model to extract JSON from text, through the chat completions REST API. */
@Injectable()
export class WebsiteExtractionClient {
  private readonly logger = new Logger('Website');

  constructor(
    @Inject(WEBSITE_CONFIG) private readonly config: ExtractionConfig,
    @Inject(WEBSITE_OPENAI_FETCH) private readonly fetchFn: typeof fetch,
  ) {}

  isAvailable(): boolean {
    return this.config.enabled && this.config.apiKey !== null;
  }

  get model(): string {
    return this.config.model;
  }

  async extract(request: ExtractionRequest, options: ExtractionCallOptions): Promise<ExtractionAnswer> {
    const { operation } = request;
    const { baseUrl, apiKey } = this.config;
    if (!this.config.enabled) throw new WebsiteError('disabled', { operation });
    if (!apiKey) throw new WebsiteError('not_configured', { operation });
    if (options.signal.aborted) throw new WebsiteError('cancelled', { operation });
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) throw new WebsiteError('timeout', { operation });

    const timeout = AbortSignal.timeout(remaining);
    const started = Date.now();
    try {
      const response = await this.fetchFn(baseUrl + CHAT_COMPLETIONS_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...openAiAuthHeaders(apiKey) },
        body: JSON.stringify(this.requestBody(request)),
        signal: AbortSignal.any([options.signal, timeout]),
        redirect: 'error',
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, MAX_ERROR_DETAIL);
        this.log('warn', 'http_error', { operation, status: response.status, detail, correlationId: options.correlationId });
        throw httpError(response.status, operation);
      }
      const answer = readAnswer(parseJson(await response.text(), operation), operation);
      this.log('debug', 'extraction_ok', {
        operation,
        durationMs: Date.now() - started,
        inputTokens: answer.usage.inputTokens,
        outputTokens: answer.usage.outputTokens,
        correlationId: options.correlationId,
      });
      return answer;
    } catch (error) {
      const err = error instanceof WebsiteError ? error : abortOrNetworkError(operation, options.signal, timeout);
      this.log('warn', 'extraction_failed', {
        operation,
        code: err.code,
        status: err.details.status,
        durationMs: Date.now() - started,
        correlationId: options.correlationId,
      });
      throw err;
    }
  }

  private requestBody(request: ExtractionRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: [
        { role: 'developer', content: request.instructions },
        { role: 'user', content: request.input },
      ],
      max_completion_tokens: MAX_COMPLETION_TOKENS,
      response_format: { type: 'json_schema', json_schema: { name: request.schemaName, schema: request.schema } },
      store: false,
    };
    if (this.config.reasoningEffort) body.reasoning_effort = this.config.reasoningEffort;
    return body;
  }

  private log(level: 'debug' | 'warn', event: string, fields: LogFields): void {
    this.logger[level]({ event: `website.${event}`, ...fields });
  }
}

function readAnswer(body: unknown, operation: string): ExtractionAnswer {
  const choice = isRecord(body) && Array.isArray(body.choices) ? (body.choices[0] as unknown) : undefined;
  const message = isRecord(choice) ? choice.message : undefined;
  const content = isRecord(message) ? message.content : undefined;
  if (typeof content !== 'string') throw new WebsiteError('malformed_response', { operation });
  const usage = isRecord(body) && isRecord(body.usage) ? body.usage : {};
  return {
    output: parseJson(jsonObjectIn(content), operation),
    usage: { inputTokens: numberOrUndefined(usage.prompt_tokens), outputTokens: numberOrUndefined(usage.completion_tokens) },
  };
}

/** Tolerates code fences or a sentence around the JSON object, for models without structured output. */
function jsonObjectIn(text: string): string {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return start === -1 || end < start ? text : text.slice(start, end + 1);
}

function httpError(status: number, operation: string): WebsiteError {
  if (status === 429) return new WebsiteError('rate_limited', { operation, status });
  if (status >= 500 || status === 408) return new WebsiteError('upstream_unavailable', { operation, status });
  if (status === 401 || status === 403) return new WebsiteError('auth_failed', { operation, status });
  return new WebsiteError('invalid_request', { operation, status });
}

function abortOrNetworkError(operation: string, signal: AbortSignal, timeout: AbortSignal): WebsiteError {
  if (signal.aborted) return new WebsiteError('cancelled', { operation });
  if (timeout.aborted) return new WebsiteError('timeout', { operation });
  return new WebsiteError('upstream_unavailable', { operation });
}

function parseJson(text: string, operation: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WebsiteError('malformed_response', { operation });
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
