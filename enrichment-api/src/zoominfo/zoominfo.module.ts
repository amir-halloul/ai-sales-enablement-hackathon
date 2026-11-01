import { Module } from '@nestjs/common';
import { ZoomInfoClient } from './zoominfo.client.js';
import { loadZoomInfoConfig, ZOOMINFO_CONFIG, ZOOMINFO_FETCH } from './zoominfo.config.js';
import { ZoomInfoService } from './zoominfo.service.js';
import { ZoomInfoTokenProvider } from './zoominfo-token.provider.js';
import { ZoomInfoTransport } from './zoominfo.transport.js';

@Module({
  providers: [
    { provide: ZOOMINFO_CONFIG, useFactory: () => loadZoomInfoConfig(process.env) },
    { provide: ZOOMINFO_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies typeof fetch },
    ZoomInfoTransport,
    ZoomInfoTokenProvider,
    ZoomInfoClient,
    ZoomInfoService,
  ],
  exports: [ZoomInfoService],
})
export class ZoomInfoModule {}
