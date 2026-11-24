import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from '@slideify/config';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';
const { json, urlencoded } = require('express');
async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix(config.apiPrefix);
  app.enableCors({
    origin: config.appUrl,
    credentials: true,
  });

  // Common envelope for body-parser failures (oversized body, malformed JSON).
  app.use(json({ limit: '100kb' }));
  app.use(urlencoded({ extended: true, limit: '100kb' }));
  app.use((err: any, req: any, res: any, next: any) => {
    if (res.headersSent) return next(err);
    if (err?.status === 413 || err?.statusCode === 413 || err?.type === 'entity.too.large') {
      res.status(413).json({
        statusCode: 413,
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Corps de requête trop volumineux.',
        timestamp: new Date().toISOString(),
        path: req.url,
      });
      return;
    }
    if (err instanceof SyntaxError) {
      res.status(400).json({
        statusCode: 400,
        code: 'INVALID_JSON',
        message: 'JSON invalide.',
        timestamp: new Date().toISOString(),
        path: req.url,
      });
      return;
    }
    next(err);
  });

  app.use((req: any, res: any, next: any) => {
    const originalJson = res.json.bind(res);
    res.json = (body: any) => {
      if (res.statusCode === 404 && (!body || typeof body?.code !== 'string')) {
        return originalJson({
          statusCode: 404,
          code: 'NOT_FOUND',
          message: 'Ressource introuvable.',
          timestamp: new Date().toISOString(),
          path: req.url,
        });
      }
      return originalJson(body);
    };
    next();
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(3001);
  logger.log(`API running on port 3001 (env: ${config.nodeEnv})`);
}

bootstrap();