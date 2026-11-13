import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from '@slideify/config';
import { Logger } from '@nestjs/common';
import { HttpExceptionFilter } from './common/errors/http-exception.filter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix(config.apiPrefix);
  app.enableCors({
    origin: config.appUrl,
    credentials: true,
  });

  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(3001);
  logger.log(`API running on port 3001 (env: ${config.nodeEnv})`);
}

bootstrap();