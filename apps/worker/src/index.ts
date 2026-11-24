import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { createLLMProvider } from '@slideify/llm';
import { prisma } from '@slideify/schema';
import { GenerationJobSchema, GenerationStatus } from '@slideify/shared';
import { Logger } from './utils/logger';
import { processGeneration } from './processor';
import { MAX_ATTEMPTS } from './claim';

export interface WorkerHandle {
  worker: Worker;
  queue: Queue;
  close: () => Promise<void>;
}

/** D-18 : plafond absolu de 5 min entre création et état terminal. */
export const ABSOLUTE_CEILING_MS = 5 * 60 * 1000;
/** Réconciliateur : tourne chaque minute. */
export const REAPER_INTERVAL_MS = 60 * 1000;

const ACTIVE_STATUSES: GenerationStatus[] = [
  GenerationStatus.QUEUED,
  GenerationStatus.PROCESSING_LLM,
  GenerationStatus.PROCESSING_RENDER,
];

export interface ReaperDb {
  generation: {
    findMany(args: {
      where: {
        status: { in: GenerationStatus[] };
        createdAt: { lt: Date };
      };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    updateMany(args: {
      where: { id: string; status: { in: GenerationStatus[] } };
      data: { status: GenerationStatus; error: string };
    }): Promise<{ count: number }>;
  };
}

/**
 * Échoue toute génération non terminale plus âgée que le plafond absolu.
 * L'horloge est injectable pour le test de non-régression (job QUEUED sans
 * worker, worker mort, Redis vidé).
 */
export async function reapStaleGenerations(
  db: ReaperDb,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - ABSOLUTE_CEILING_MS);
  const stale = await db.generation.findMany({
    where: { status: { in: ACTIVE_STATUSES }, createdAt: { lt: cutoff } },
    select: { id: true },
  });

  let failed = 0;
  for (const gen of stale) {
    const updated = await db.generation.updateMany({
      where: { id: gen.id, status: { in: ACTIVE_STATUSES } },
      data: { status: GenerationStatus.FAILED, error: 'TIMEOUT' },
    });
    if (updated.count === 1) {
      failed += 1;
      logger.warn(`Generation ${gen.id} failed by reaper (absolute 5-minute ceiling)`);
    }
  }
  return failed;
}

const logger = new Logger('worker');

export async function reconcileQueuedGenerations(queue: Queue): Promise<number> {
  const queued = await prisma.generation.findMany({
    where: { status: GenerationStatus.QUEUED },
    select: { id: true },
  });

  let enqueued = 0;
  for (const generation of queued) {
    try {
      await queue.add(
        'generation',
        { generationId: generation.id },
        { jobId: generation.id, attempts: MAX_ATTEMPTS, backoff: { type: 'exponential', delay: 2000 } },
      );
      enqueued += 1;
    } catch (error) {
      // A job with the same deterministic jobId already exists: idempotent.
      const message = error instanceof Error ? error.message : String(error);
      if (!/already exists|duplicate/i.test(message)) {
        logger.error(`Unable to reconcile queued generation ${generation.id}`, error as Error);
      }
    }
  }
  return enqueued;
}

export async function main(): Promise<WorkerHandle> {
  logger.info('Starting Slideify generation worker (M004: structured slides only, no rendering)...');

  // Fail before accepting jobs if a non-mock provider is configured but not
  // implemented. Never silently fall back to mock.
  const llmProvider = createLLMProvider();

  const connection = {
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password,
  };

  const queue = new Queue('generation', {
    connection,
    defaultJobOptions: {
      attempts: MAX_ATTEMPTS,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: { age: 3600 },
      removeOnFail: { age: 86400, count: 50 },
    },
  });

  await reconcileQueuedGenerations(queue);

  const worker = new Worker(
    'generation',
    async (job) => {
      const parsed = GenerationJobSchema.safeParse(job.data);
      if (!parsed.success) {
        logger.error(`Poison job ${job.id}: payload must contain only generationId`);
        return 'skipped';
      }
      const attemptsMade = job.attemptsMade ?? 0;
      const maxAttempts =
        typeof job.opts?.attempts === 'number' && job.opts.attempts > 0
          ? job.opts.attempts
          : MAX_ATTEMPTS;

      return processGeneration(prisma, llmProvider, {
        generationId: parsed.data.generationId,
        attemptsMade,
        maxAttempts,
      });
    },
    { connection, concurrency: 1 },
  );

  worker.on('failed', (job, error) => {
    logger.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts: ${error.message}`);
  });
  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed successfully`);
  });

  const reaper = () => {
    void reapStaleGenerations(prisma).catch((error) => {
      logger.error(`Reaper error: ${error}`);
    });
  };
  const reaperInterval = setInterval(reaper, REAPER_INTERVAL_MS);
  const initialReaper = setTimeout(reaper, 5000);

  const close = async () => {
    clearInterval(reaperInterval);
    clearTimeout(initialReaper);
    await worker.close();
    await queue.close();
    await prisma.$disconnect();
  };

  logger.info('Worker connected to BullMQ queue (single consumer: apps/worker)');
  return { worker, queue, close };
}

if (require.main === module) {
  main()
    .then((handle) => {
      const shutdown = () => {
        void handle.close().then(() => process.exit(0));
      };
      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
    })
    .catch((error) => {
      logger.error('Worker failed to start', error);
      process.exit(1);
    });
}
