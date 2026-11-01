import type { LoggerService } from '@nestjs/common';
import { trace } from '@opentelemetry/api';

type Severity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL';

type Attributes = Record<string, unknown>;

/** Snowflake drops log records over 16 KiB, so long strings are cut well below that. */
const MAX_STRING_LENGTH = 2_000;
const MAX_STACK_LENGTH = 8_000;

/**
 * Writes one JSON line per log in the format SPCS parses into event table columns:
 * severity_text -> RECORD, body -> VALUE, attributes -> RECORD_ATTRIBUTES, scope -> SCOPE.
 * Log an object with an `event` name, e.g. `logger.warn({ event: 'cache.read_failed', source })`:
 * the event becomes the body and the other fields the attributes.
 */
export class JsonLogger implements LoggerService {
  constructor(private readonly write: (line: string, severity: Severity) => void = writeToStream) {}

  log(message: unknown, ...params: unknown[]): void {
    this.emit('INFO', message, contextOf(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.emit('WARN', message, contextOf(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.emit('DEBUG', message, contextOf(params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.emit('DEBUG', message, contextOf(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    const { stack, context } = errorParams(params);
    this.emit('ERROR', message, context, stack);
  }

  fatal(message: unknown, ...params: unknown[]): void {
    const { stack, context } = errorParams(params);
    this.emit('FATAL', message, context, stack);
  }

  private emit(severity: Severity, message: unknown, context: string | undefined, stack?: string): void {
    const { body, attributes } = bodyAndAttributes(message);
    if (stack) attributes['exception.stacktrace'] = stack;

    const record = {
      timestamp: new Date().toISOString(),
      severity_text: severity,
      body: truncate(body, MAX_STRING_LENGTH),
      scope: { name: context ?? 'app' },
      attributes: { ...truncateAttributes(attributes), ...traceAttributes() },
    };
    this.write(serialize(record), severity);
  }
}

function writeToStream(line: string, severity: Severity): void {
  const stream = severity === 'ERROR' || severity === 'FATAL' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

/** Nest appends the logger's context as the last parameter. */
function contextOf(params: unknown[]): string | undefined {
  const last = params.at(-1);
  return typeof last === 'string' ? last : undefined;
}

/** Nest calls error(message, stack, context); with one parameter it is a stack only if it spans lines. */
function errorParams(params: unknown[]): { stack?: string; context?: string } {
  if (params.length >= 2) {
    const stack = typeof params[0] === 'string' ? params[0] : undefined;
    return { stack, context: contextOf(params) };
  }
  const only = params[0];
  if (typeof only !== 'string') return {};
  return only.includes('\n') ? { stack: only } : { context: only };
}

function bodyAndAttributes(message: unknown): { body: string; attributes: Attributes } {
  if (message instanceof Error) {
    return { body: message.message, attributes: { 'exception.type': message.name, 'exception.stacktrace': message.stack } };
  }
  if (typeof message === 'object' && message !== null) {
    const { event, ...fields } = message as Attributes;
    if (typeof event === 'string') return { body: event, attributes: fields };
    return { body: toText(message), attributes: {} };
  }
  return { body: String(message), attributes: {} };
}

/** Lets the event table join logs to the request's trace. */
function traceAttributes(): Attributes {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const { traceId, spanId } = span.spanContext();
  return { trace_id: traceId, span_id: spanId };
}

function truncateAttributes(attributes: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    const max = key === 'exception.stacktrace' ? MAX_STACK_LENGTH : MAX_STRING_LENGTH;
    result[key] = typeof value === 'string' ? truncate(value, max) : value;
  }
  return result;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** A log call must never throw, even for values JSON can't represent (BigInt, cycles). */
function serialize(record: Attributes): string {
  try {
    return JSON.stringify(record);
  } catch {
    return JSON.stringify({ ...record, attributes: { 'log.attributes_dropped': true } });
  }
}

function toText(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
