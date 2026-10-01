import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { BullMQModule } from './bullmq/bullmq.module';
import { JwtAuthGuard } from './auth/jwt.guard';
import { GenerationController } from './generation/generation.controller';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    BullMQModule,
  ],
  controllers: [HealthController, GenerationController],
  providers: [JwtAuthGuard],
})
export class AppModule {}