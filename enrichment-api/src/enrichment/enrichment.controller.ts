import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Body, Controller, HttpCode, HttpException, Inject, Logger, Post, Req, Res, UseGuards } from '@nestjs/common';
import { trace } from '@opentelemetry/api';
import { ApiKeyGuard } from '../auth/api-key.guard.js';
import { recordRequest } from '../telemetry/instruments.js';
import { EnrichmentError } from './enrichment.errors.js';
import { EnrichmentService, type RequestContext } from './enrichment.service.js';
import type { EnrichResponse, IdentifyResponse, ProviderOutcome } from './enrichment.types.js';
import { RequestRateLimiter } from './rate-limit/request-rate-limiter.js';
import { parseEnrichRequest, parseIdentifyRequest } from './validation.js';

const CORRELATION_HEADER = 'x-correlation-id';
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

const logger = new Logger('EnrichmentApi');

@Controller('v1')
@UseGuards(ApiKeyGuard)
export class EnrichmentController {
  constructor(
    @Inject(EnrichmentService) private readonly service: EnrichmentService,
    @Inject(RequestRateLimiter) private readonly rateLimiter: RequestRateLimiter,
  ) {}

  @Post('identify')
  @HttpCode(200)
  identify(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse): Promise<IdentifyResponse> {
    const ctx = requestContext(req, res);
    return handle('identify', ctx, res, () => {
      this.rateLimiter.check('identify', req);
      return this.service.identify(parseIdentifyRequest(body), ctx);
    });
  }

  @Post('enrich')
  @HttpCode(200)
  enrich(@Body() body: unknown, @Req() req: IncomingMessage, @Res({ passthrough: true }) res: ServerResponse): Promise<EnrichResponse> {
    const ctx = requestContext(req, res);
    return handle('enrich', ctx, res, () => {
      this.rateLimiter.check('enrich', req);
      const { target, refresh } = parseEnrichRequest(body);
      return this.service.enrich(target, ctx, { refresh });
    });
  }
}

/** Echoes a safe caller correlation ID (or a new one) and cancels provider calls when the caller disconnects. */
function requestContext(req: IncomingMessage, res: ServerResponse): RequestContext {
  const header = req.headers[CORRELATION_HEADER];
  const correlationId = typeof header === 'string' && CORRELATION_ID_PATTERN.test(header) ? header : randomUUID();
  res.setHeader('X-Correlation-Id', correlationId);

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) abort.abort();
  });
  return { signal: abort.signal, correlationId };
}

/** Runs the request, sets Retry-After on throttling, and logs one line per request. */
async function handle<T extends { providers: ProviderOutcome[] }>(
  operation: string,
  ctx: RequestContext,
  res: ServerResponse,
  run: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  labelHttpSpan(operation, ctx);
  try {
    const response = await run();
    logRequest(operation, ctx, started, 'ok', response.providers);
    return response;
  } catch (error) {
    if (error instanceof EnrichmentError && error.retryAfterMs) {
      res.setHeader('Retry-After', Math.ceil(error.retryAfterMs / 1000));
    }
    logRequest(operation, ctx, started, errorCode(error), error instanceof EnrichmentError ? error.providers : []);
    throw error;
  }
}

/** Logs identifiers and statuses only: never names or contact data. */
function logRequest(operation: string, ctx: RequestContext, started: number, result: string, providers: ProviderOutcome[]): void {
  const durationMs = Date.now() - started;
  recordRequest(operation, result, durationMs);
  logger.log({
    event: 'api.request',
    operation,
    correlationId: ctx.correlationId,
    result,
    durationMs,
    providers: providers.map((p) => [p.provider, p.status, p.error].filter(Boolean).join(':')),
  });
}

/** The http instrumentation only knows the method; the route and correlation ID make traces findable. */
function labelHttpSpan(operation: string, ctx: RequestContext): void {
  const span = trace.getActiveSpan();
  span?.updateName(`POST /v1/${operation}`);
  span?.setAttributes({ 'http.route': `/v1/${operation}`, 'enrichment.correlation_id': ctx.correlationId });
}

function errorCode(error: unknown): string {
  if (error instanceof EnrichmentError) return error.code;
  if (error instanceof HttpException) return `http_${error.getStatus()}`;
  return 'internal_error';
}
