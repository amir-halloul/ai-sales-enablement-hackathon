import type { IncomingMessage } from 'node:http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-grpc';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { metrics, NodeSDK, resources } from '@opentelemetry/sdk-node';
import { SnowflakeIdGenerator } from './snowflake-id-generator.js';

const SERVICE_NAME = 'enrichment-api';
const METRIC_EXPORT_INTERVAL_MS = 60_000;

let sdk: NodeSDK | undefined;

/**
 * Sends traces and metrics to the OTel collector that SPCS runs next to the container, which writes them
 * to the account's event table. Without the SPCS endpoints (locally, in tests) telemetry stays a no-op.
 * Must run before Nest loads, so http is patched: see register.ts.
 */
export function startTelemetry(): void {
  const { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT } = process.env;
  if (!OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || !OTEL_EXPORTER_OTLP_METRICS_ENDPOINT) return;

  sdk = new NodeSDK({
    serviceName: SERVICE_NAME,
    resource: resources.resourceFromAttributes({ 'service.version': process.env.APP_VERSION ?? 'dev' }),
    idGenerator: new SnowflakeIdGenerator(),
    traceExporter: new OTLPTraceExporter(),
    metricReaders: [
      new metrics.PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter(), exportIntervalMillis: METRIC_EXPORT_INTERVAL_MS }),
    ],
    // Logs go to stdout, which SPCS already collects.
    logRecordProcessors: [],
    instrumentations: [new HttpInstrumentation({ ignoreIncomingRequestHook: isHealthProbe }), new UndiciInstrumentation()],
  });
  sdk.start();
}

/** Flushes pending spans and metrics. */
export async function shutdownTelemetry(): Promise<void> {
  await sdk?.shutdown();
  sdk = undefined;
}

function isHealthProbe(request: IncomingMessage): boolean {
  return request.url === '/health';
}
