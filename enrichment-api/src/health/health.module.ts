import { Module } from '@nestjs/common';
import { DnbModule } from '../dnb/dnb.module.js';
import { WebSearchModule } from '../web-search/web-search.module.js';
import { ZoomInfoModule } from '../zoominfo/zoominfo.module.js';
import { HealthController } from './health.controller.js';
import { HealthService } from './health.service.js';

@Module({
  imports: [ZoomInfoModule, DnbModule, WebSearchModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
