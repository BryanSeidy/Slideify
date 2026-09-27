import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from '@slideify/config';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix(config.apiPrefix);
  app.enableCors({
    origin: config.appUrl,
    credentials: true,
  });

  await app.listen(3001);
  logger.log(`API running on port 3001 (env: ${config.nodeEnv})`);
}

bootstrap();