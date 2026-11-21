import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { BullMQModule } from './bullmq/bullmq.module';
import { GenerationModule } from './generation/generation.module';
import { AuthModule } from './auth/auth.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    BullMQModule,
    AuthModule,
    GenerationModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
