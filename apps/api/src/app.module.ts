import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { GenerationModule } from './generation/generation.module';
import { CreditsModule } from './credits/credits.module';
import { PaymentModule } from './payment/payment.module';
import { BullMQModule } from './bullmq/bullmq.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
    }),
    PrismaModule,
    AuthModule,
    GenerationModule,
    CreditsModule,
    PaymentModule,
    BullMQModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}