import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { createLLMProvider } from '@slideify/llm';
import { prisma } from '@slideify/schema';
import { GenerationStatus } from '@slideify/shared';
import { Logger } from './utils/logger';
import { processGeneration } from './processor';
import { MAX_ATTEMPTS } from './claim';

// P1.4 — Plafond absolu : 5 minutes entre création et état terminal.
const ABSOLUTE_CEILING_MS = 5 * 60 * 1000;
// P1.4 — Réconciliateur : tourne chaque minute.
const REAPER_INTERVAL_MS = 60 * 1000;

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

  // P1.4 — Réconciliateur : échoue les générations bloquées en PROCESSING_*
  // depuis plus de 5 minutes (couvre les jobs perdus, worker mort, Redis down).
  const reapStaleGenerations = async () => {
    try {
      const now = new Date();
      const cutoff = new Date(now.getTime() - ABSOLUTE_CEILING_MS);
      const stale = await prisma.generation.findMany({
        where: {
          status: {
            in: [GenerationStatus.PROCESSING_LLM, GenerationStatus.PROCESSING_RENDER],
          },
          createdAt: { lt: cutoff },
        },
      });
      for (const gen of stale) {
        await prisma.generation.update({
          where: { id: gen.id },
          data: { status: GenerationStatus.FAILED, error: 'TIMEOUT' },
        });
        logger.warn(`Generation ${gen.id} failed by reaper (timeout after 5 min)`);
      }
    } catch (error) {
      logger.error(`Reaper error: ${error}`);
    }
  };

  setInterval(reapStaleGenerations, REAPER_INTERVAL_MS);
  // Run once shortly after startup to catch pre-existing stuck generations.
  setTimeout(reapStaleGenerations, 5000);

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
