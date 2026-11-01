import { describe, expect, it } from 'vitest';
import { JsonLogger } from './json-logger.js';

interface Line {
  severity: string;
  record: Record<string, unknown>;
}

function capture(): { logger: JsonLogger; lines: Line[] } {
  const lines: Line[] = [];
  const logger = new JsonLogger((line, severity) => lines.push({ severity, record: JSON.parse(line) as Record<string, unknown> }));
  return { logger, lines };
}

describe('JsonLogger', () => {
  it('turns an event object into body, attributes and scope', () => {
    const { logger, lines } = capture();

    logger.warn({ event: 'cache.read_failed', source: 'dnb', correlationId: 'c-1' }, 'SourceCache');

    expect(lines).toHaveLength(1);
    expect(lines[0].record).toMatchObject({
      severity_text: 'WARN',
      body: 'cache.read_failed',
      scope: { name: 'SourceCache' },
      attributes: { source: 'dnb', correlationId: 'c-1' },
    });
    expect(Date.parse(lines[0].record.timestamp as string)).not.toBeNaN();
  });

  it('keeps plain strings as the body', () => {
    const { logger, lines } = capture();

    logger.log('Listening on port 8080', 'Bootstrap');

    expect(lines[0].record).toMatchObject({ severity_text: 'INFO', body: 'Listening on port 8080', scope: { name: 'Bootstrap' } });
  });

  it('reads the stack and context that Nest Logger passes to error()', () => {
    const { logger, lines } = capture();

    // new Logger(context).error(message, stack?) forwards (message, stack | undefined, context).
    logger.error({ event: 'provider.unexpected_error', provider: 'dnb' }, 'Error: boom\n    at x', 'EnrichmentService');
    logger.error({ event: 'health.failed' }, undefined, 'Health');

    expect(lines[0]).toMatchObject({
      severity: 'ERROR',
      record: {
        body: 'provider.unexpected_error',
        scope: { name: 'EnrichmentService' },
        attributes: { provider: 'dnb', 'exception.stacktrace': 'Error: boom\n    at x' },
      },
    });
    expect(lines[1].record).toMatchObject({ body: 'health.failed', scope: { name: 'Health' }, attributes: {} });
  });

  it('cuts long strings so a record stays under the event table limit', () => {
    const { logger, lines } = capture();

    logger.warn({ event: 'http_error', detail: 'x'.repeat(50_000) }, 'DnB');

    expect((lines[0].record.attributes as { detail: string }).detail.length).toBeLessThan(2_100);
  });

  it('never throws on values JSON cannot represent', () => {
    const { logger, lines } = capture();

    logger.log({ event: 'odd', count: 1n }, 'Test');

    expect(lines[0].record).toMatchObject({ body: 'odd', attributes: { 'log.attributes_dropped': true } });
  });
});
