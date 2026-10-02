import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { config } from '@slideify/config';

export function getRedisConfig() {
  return {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  };
}

export function getQueueOptions() {
  return {
    connection: getRedisConfig(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400, count: 50 },
    },
  };
}

@Module({
  imports: [
    BullModule.forRoot({
      connection: getRedisConfig(),
    }),
  ],
  exports: [BullModule],
})
export class BullMQModule {}
