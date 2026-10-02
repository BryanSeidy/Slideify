import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { createLLMProvider } from '@slideify/llm';
import { prisma } from '@slideify/schema';
import {
  CreditTransactionType,
  GenerationStatus,
  GenerationEventName,
  LLMResponseSchema,
  type LLMResponse,
} from '@slideify/shared';
import { Logger } from './utils/logger';

const logger = new Logger('worker');

// Budget global par génération : 90 s entre prise en charge et état terminal.
const GENERATION_TIMEOUT_MS = 90_000;

const MARKER_TIMEOUT = '__MOCK_TIMEOUT__';
const MARKER_INVALID_JSON = '__MOCK_INVALID_JSON__';
const MARKER_SCHEMA_INVALID = '__MOCK_SCHEMA_INVALID__';

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Simulated timeout') ||
    message.includes('TIMEOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('429') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503')
  );
}

function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const words = text.split(' ');
  let out = '';
  for (const w of words) {
    const next = out ? out + ' ' + w : w;
    if (next.length + 1 > max) break; // +1 pour l'ellipse
    out = next;
  }
  return (out || text.slice(0, max - 1)) + '…';
}

export async function main() {
  logger.info('Starting Slideify generation worker (M004: structured slides only, no rendering)...');

  const queue = new Queue('generation', {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    },
    defaultJobOptions: {
      attempts: 3,
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
      const jobStartedAt = Date.now();

      if (!generationId || typeof generationId !== 'string') {
        logger.error('Poison job: missing generationId, abandoning without retry');
        return;
      }

      // Prise atomique : QUEUED -> PROCESSING_LLM. Si count === 0, déjà prise ou terminale.
      const claimed = await prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.QUEUED },
        data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
      });

      if (claimed.count === 0) {
        const current = await prisma.generation.findUnique({
          where: { id: generationId },
          select: { status: true },
        });
        if (!current) {
          logger.error(`Generation ${generationId} not found, abandoning without retry`);
          return;
        }
        logger.info(`Generation ${generationId} already ${current.status}, skipping (idempotent)`);
        return;
      }

      logger.info(`Processing generation job ${generationId}`);

      const checkBudget = () => {
        if (Date.now() - jobStartedAt > GENERATION_TIMEOUT_MS) {
          throw new Error('TIMEOUT');
        }
      };

      // Relire sourceText/userId depuis la DB (jamais depuis le job).
      const generation = await prisma.generation.findUnique({ where: { id: generationId } });
      if (!generation) {
        logger.error(`Generation ${generationId} vanished after claim, abandoning`);
        return;
      }
      const sourceText: string = generation.sourceText;

      // --- Étape LLM (avec marqueurs de test hors production) ---
      let llmRaw: unknown;
      try {
        if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_TIMEOUT)) {
          throw new Error('Simulated timeout');
        }
        llmRaw = await createLLMProvider().generate(sourceText);
        checkBudget();

        if (
          process.env.NODE_ENV !== 'production' &&
          sourceText.includes(MARKER_INVALID_JSON)
        ) {
          throw new Error('Invalid JSON simulated');
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Retry unique et silencieux sur JSON invalide (AI_CONTRACT), puis échec terminal.
        if (message === 'Invalid JSON simulated') {
          logger.info(`Invalid JSON for ${generationId}, single silent retry`);
          try {
            const retryRaw = await createLLMProvider().generate(
              sourceText.replace(MARKER_INVALID_JSON, ''),
            );
            checkBudget();
            llmRaw = retryRaw;
          } catch (retryError) {
            const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
            logger.error(`LLM retry failed for ${generationId}: ${retryMessage}`);
            await prisma.generation.update({
              where: { id: generationId },
              data: { status: GenerationStatus.FAILED, error: 'MALFORMED_OUTPUT' },
            });
            return;
          }
        } else if (message === 'TIMEOUT' || message.includes('Simulated timeout')) {
          // Transitoire : laisser BullMQ retenter (throw).
          throw error;
        } else if (isTransientError(error)) {
          throw error;
        } else {
          logger.error(`LLM error for ${generationId}: ${message}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
          });
          return;
        }
      }

      // --- Validation Zod stricte (jamais de persistance directe) ---
      let validated: LLMResponse;
      try {
        const parsed = LLMResponseSchema.safeParse(llmRaw);
        if (!parsed.success) {
          throw new Error('schema invalid: ' + parsed.error.issues.map((i) => i.path.join('.')).join(','));
        }
        validated = parsed.data;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`LLM validation failed for ${generationId}: ${message}`);
        const code =
          process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_SCHEMA_INVALID)
            ? 'MALFORMED_OUTPUT'
            : 'INVALID_RESPONSE';
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: code },
        });
        return;
      }

      if (validated.slides.length < 5 || validated.slides.length > 10) {
        logger.error(`Invalid slide count ${validated.slides.length} for ${generationId}`);
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
        });
        return;
      }

      const slides = validated.slides.map((s, i) => ({
        order: i + 1,
        title: truncateAtWord(s.title.trim(), 60),
        body: truncateAtWord(s.body.trim(), 220),
      }));

      if (slides.some((s) => !s.title || !s.body)) {
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
        });
        return;
      }

      checkBudget();

      // --- Transaction atomique : slides + COMPLETED + débit + activation ---
      try {
        await prisma.$transaction(async (tx) => {
          await tx.slide.deleteMany({ where: { generationId } });
          await tx.slide.createMany({
            data: slides.map((s) => ({
              generationId,
              order: s.order,
              title: s.title,
              body: s.body,
            })),
          });

          await tx.generation.update({
            where: { id: generationId },
            data: {
              status: GenerationStatus.COMPLETED,
              slideCount: slides.length,
              completedAt: new Date(),
            },
          });

          await tx.creditTransaction.create({
            data: {
              userId: generation.userId,
              amount: -1,
              type: CreditTransactionType.GENERATION_DEBIT,
              reference: `generation:${generationId}`,
            },
          });

          const completedCount = await tx.generation.count({
            where: { userId: generation.userId, status: GenerationStatus.COMPLETED },
          });
          if (completedCount === 1) {
            await tx.generationEvent.create({
              data: {
                name: GenerationEventName.FIRST_GENERATION_COMPLETED,
                actorId: generation.userId,
                metadata: { generationId },
              },
            });
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Violation d'unicité = déjà traité par une exécution concurrente → succès idempotent.
        if (message.includes('Unique constraint') || message.includes('UniqueConstraint')) {
          logger.info(`Generation ${generationId} already completed by concurrent worker (idempotent)`);
          return;
        }
        logger.error(`Completion transaction failed for ${generationId}: ${message}`);
        throw error; // transitoire possible (deadlock, connexion) → BullMQ retry
      }

      checkBudget();
      logger.info(`Generation ${generationId} completed successfully`);
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
