import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { BullMQModule } from './bullmq/bullmq.module';
import { GenerationModule } from './generation/generation.module';
import { JwtModuleNest } from './auth/jwt.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    BullMQModule,
    JwtModuleNest,
    GenerationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
