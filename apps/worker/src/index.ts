import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { createLLMProvider } from '@slideify/llm';
import { prisma } from '@slideify/schema';
import { Logger } from './utils/logger';
import { processGeneration } from './processor';
import { MAX_ATTEMPTS } from './claim';

const logger = new Logger('worker');

export async function main() {
  logger.info('Starting Slideify generation worker (M004: structured slides only, no rendering)...');

  const queue = new Queue('generation', {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    },
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400, count: 50 },
    },
  });
  void queue;

  const worker = new Worker(
    'generation',
    async (job) => {
      const { generationId } = job.data as { generationId: string };
      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts =
        typeof job.opts?.attempts === 'number' && job.opts.attempts > 0 ? job.opts.attempts : MAX_ATTEMPTS;

      // processGeneration throws transient errors while retries remain so that
      // BullMQ really redelivers; semantic errors end in FAILED without retry.
      await processGeneration(prisma, createLLMProvider(), {
        generationId,
        attemptsMade,
        maxAttempts,
      });
    },
    {
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
      },
      concurrency: 1,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts: ${error.message}`);
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed successfully`);
  });

  const shutdown = async () => {
    logger.info('SIGTERM received, closing worker gracefully...');
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  logger.info('Worker connected to BullMQ queue (single consumer: apps/worker)');
}

main().catch((error) => {
  logger.error('Worker failed to start', error);
  process.exit(1);
});
