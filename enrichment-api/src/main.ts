import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { JsonLogger } from './common/json-logger.js';

async function bootstrap(): Promise<void> {
  // LOG_FORMAT=text keeps Nest's colored console output for local runs.
  const logger = process.env.LOG_FORMAT === 'text' ? new ConsoleLogger() : new JsonLogger();
  const app = await NestFactory.create(AppModule, { logger });
  app.enableShutdownHooks();

  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Listening on port ${port}`, 'Bootstrap');
}

void bootstrap();
