import { Controller, Get, Inject } from '@nestjs/common';
import { HealthService, type HealthReport } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /** Always 200 (this is the SPCS readiness probe): an upstream outage only degrades enrichment. */
  @Get()
  check(): Promise<HealthReport> {
    return this.health.check();
  }
}
