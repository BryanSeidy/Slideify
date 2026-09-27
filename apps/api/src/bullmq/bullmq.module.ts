import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GenerationJob } from '@slideify/shared';
import { RedisConfig } from '../config/config';

export function getRedisConfig() {
  return {
    host: RedisConfig.redis.host,
    port: RedisConfig.redis.port,
    password: RedisConfig.redis.password,
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
    BullModule.forRootAsync({
      useFactory: () => ({
        connection: getRedisConfig(),
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: { age: 3600 },
          removeOnFail: { age: 86400, count: 50 },
        },
      }),
    }),
  ],
})
export class BullMQModule {}