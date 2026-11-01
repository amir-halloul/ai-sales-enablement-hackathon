import { Module } from '@nestjs/common';
import { EnrichmentModule } from './enrichment/enrichment.module.js';
import { HealthModule } from './health/health.module.js';
import { HelloController } from './hello/hello.controller.js';
import { TelemetryShutdown } from './telemetry/telemetry-shutdown.js';

@Module({
  imports: [EnrichmentModule, HealthModule],
  controllers: [HelloController],
  providers: [TelemetryShutdown],
})
export class AppModule {}
