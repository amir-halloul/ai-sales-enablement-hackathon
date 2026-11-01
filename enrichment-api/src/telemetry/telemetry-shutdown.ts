import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { shutdownTelemetry } from './telemetry.js';

/** Flushes telemetry when Nest shuts down (SIGTERM from SPCS), before the process exits. */
@Injectable()
export class TelemetryShutdown implements OnApplicationShutdown {
  onApplicationShutdown(): Promise<void> {
    return shutdownTelemetry();
  }
}
