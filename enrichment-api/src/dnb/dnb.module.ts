import { Module } from '@nestjs/common';
import { DnbClient } from './dnb.client.js';
import { DNB_CONFIG, DNB_FETCH, loadDnbConfig } from './dnb.config.js';

@Module({
  providers: [
    { provide: DNB_CONFIG, useFactory: () => loadDnbConfig(process.env) },
    { provide: DNB_FETCH, useValue: ((input, init) => fetch(input, init)) satisfies typeof fetch },
    DnbClient,
  ],
  exports: [DnbClient],
})
export class DnbModule {}
