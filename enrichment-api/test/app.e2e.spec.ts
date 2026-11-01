import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('enrichment-api (e2e)', () => {
  let app: INestApplication<Server>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health returns ok with the upstream dependencies', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body).toMatchObject({
      status: 'ok',
      dependencies: { zoomInfo: { status: 'disabled' }, webSearch: { status: 'disabled' } },
    });
    expect(typeof (res.body as { version: unknown }).version).toBe('string');
  });

  it('GET /hello returns a greeting', async () => {
    await request(app.getHttpServer())
      .get('/hello')
      .expect(200)
      .expect({ message: 'Hello from enrichment-api' });
  });

  it('returns 404 for unknown routes', async () => {
    await request(app.getHttpServer()).get('/nope').expect(404);
  });
});
