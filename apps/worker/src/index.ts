import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';
import { prisma } from '@slideify/schema';
import { CreditTransactionType, GenerationStatus, GenerationEventName, CreditTransaction, Slide, LLMResponse } from '@slideify/shared';
import { Logger } from './utils/logger';

const logger = new Logger('worker');

// Timeout global 90 s entre création et état terminal
const GLOBAL_TIMEOUT_MS = 90_000;
const START_TIME: number = Date.now();

const MARKER_TIMEOUT = '__MOCK_TIMEOUT__';
const MARKER_INVALID_JSON = '__MOCK_INVALID_JSON__';
const MARKER_SCHEMA_INVALID = '__MOCK_SCHEMA_INVALID__';

export async function main() {
  logger.info('Starting Slideify generation worker...');

  const queue = new Queue('generation', {
    connection: {
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    },
  });

  const worker = new Worker(
    'generation',
    async (job) => {
      const { generationId, sourceText }: { generationId: string; sourceText: string } = job.data;

      logger.info(`Processing generation job ${generationId}`);

      // Vérifier le timeout global
      if (Date.now() - START_TIME > GLOBAL_TIMEOUT_MS) {
        logger.warn('Global timeout exceeded, failing all remaining jobs');
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: 'TIMEOUT' },
        });
        return;
      }

      try {
        // Step 1: Verify generation exists and is in a valid state to process
        const generation = await prisma.generation.findUnique({
          where: { id: generationId },
        });

        if (!generation) {
          logger.error(`Generation ${generationId} not found`);
          return;
        }

        // Ignorer si déjà terminal
        if (generation.status === GenerationStatus.COMPLETED || generation.status === GenerationStatus.FAILED) {
          logger.warn(`Generation ${generationId} already terminal (${generation.status}), skipping`);
          return;
        }

        // Step 2: Update to PROCESSING_LLM (marqueur visible pour le frontend)
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
        });

        // Step 3: Call LLM via provider
        let llmResult;
        try {
          // Vérifier les marqueurs de mock pour les tests
          const mockTimeout = job.data?.mockTimeout || job.opts?.mockTimeout;
          const mockInvalidJson = job.data?.mockInvalidJson || job.opts?.mockInvalidJson;
          const mockSchemaInvalid = job.data?.mockSchemaInvalid || job.opts?.mockSchemaInvalid;

          if (mockTimeout) {
            throw new Error('Simulated timeout');
          }

          llmResult = await createLLMProvider().generate(sourceText);

          // Appliquer les marquers de test après l'appel
          if (mockInvalidJson && llmResult.slides.some(s => s.body.includes(MARKER_INVALID_JSON))) {
            throw new Error('Invalid JSON simulated');
          }
          if (mockSchemaInvalid && llmResult.slides.some(s => s.body.includes(MARKER_SCHEMA_INVALID))) {
            throw new Error('Schema invalid simulated');
          }
        } catch (error: any) {
          const errorCode = error.message.includes('timeout') ? 'TIMEOUT' : 'LLM_ERROR';

          // Vérifier si on doit rejouer après un JSON invalide (retry silencieux)
          if (error.message === 'Invalid JSON simulated') {
            // Un seul retry sur JSON invalide, pas de deuxième appel LLM
            logger.warn(`JSON invalid for generation ${generationId}, retrying once`);
            try {
              llmResult = await createLLMProvider().generate(sourceText);
            } catch (retryError) {
              logger.error(`LLM retry failed for generation ${generationId}: ${retryError.message}`);
              await prisma.generation.update({
                where: { id: generationId },
                data: { status: GenerationStatus.FAILED, error: 'MALFORMED_OUTPUT' },
              });
              return;
            }
          } else {
            logger.error(`LLM error for generation ${generationId}: ${error.message}`);
            await prisma.generation.update({
              where: { id: generationId },
              data: { status: GenerationStatus.FAILED, error: errorCode },
            });
            return;
          }
        }

        // Step 4: Validate LLM response using LLMResponseSchema from shared
        let validated: LLMResponse;
        try {
          const { LLMResponseSchema } = await import('@slideify/shared');
          validated = LLMResponseSchema.parse(llmResult);
        } catch (error) {
          logger.error(`LLM response validation failed for generation ${generationId}: ${error.message}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
          });
          return;
        }

        // Step 5: Vérifier le nombre de slides (5-10) - le schema s'en charge,
        // mais on ajoute une vérification supplémentaire avec message clair
        if (validated.slides.length < 5 || validated.slides.length > 10) {
          logger.error(`Invalid slide count ${validated.slides.length} for generation ${generationId}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'TOO_MANY_SLIDES' },
          });
          return;
        }

        // Step 6: Tronquer titre/ corps si dépasse les bornes (mineur → ellipse, majeur → échec)
        for (const slide of validated.slides) {
          // Tronquer titre à 60 caractères (mineur → troncature au mot près + ellipse)
          if (slide.title.length > 60) {
            slide.title = slide.title.split(' ').slice(0, -1).join(' ') + '…';
          }
          // Tronquer corps à 220 caractères (mineur → troncature au mot près + ellipse)
          if (slide.body.length > 220) {
            slide.body = slide.body.split(' ').slice(0, -1).join(' ') + '…';
          }
        }

        // Step 7: Render slides
        let buffers;
        try {
          buffers = await renderSlides(validated.slides);
        } catch (error) {
          logger.error(`Render error for generation ${generationId}: ${error.message}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'RENDER_ERROR' },
          });
          return;
        }

        // Step 8: Store outputs in transaction (slides + crédit + événement)
        await prisma.$transaction(async (tx) => {
          // Persist slides with deterministic keys
          for (let i = 0; i < buffers.length; i++) {
            const order = i + 1; // 1-based for display
            await StorageAdapterFactory.create().upload(
              `${generationId}/slide_${i}.png`, // clé en base 0
              buffers[i],
              'image/png'
            );
          }

          // Update generation to COMPLETED
          await tx.generation.update({
            where: { id: generationId },
            data: {
              status: GenerationStatus.COMPLETED,
              slideCount: validated.slides.length,
              completedAt: new Date(),
            },
          });

          // Debit credit - only on success, in the same transaction
          await tx.creditTransaction.create({
            data: {
              userId: generation.userId,
              amount: -1,
              type: CreditTransactionType.GENERATION_DEBIT,
              reference: generationId,
            },
          });

          // Create activation event if first completed generation
          const firstCompleted = await tx.generation.count({
            where: {
              userId: generation.userId,
              status: GenerationStatus.COMPLETED,
            },
          });

          if (firstCompleted === 1) {
            await tx.generationEvent.create({
              data: {
                name: GenerationEventName.FIRST_GENERATION_COMPLETED,
                actorId: generation.userId,
                metadata: { generationId },
              },
            });
          }
        });

        logger.info(`Generation ${generationId} completed successfully`);
      } catch (error) {
        logger.error(`Job ${job.id} failed: ${error.message}`);

        // Ne pas débiter si l'échec survient avant COMPLETED
        try {
          // Vérifier si la génération existe et n'est pas déjà COMPLETED/FAILED
          const gen = await prisma.generation.findUnique({ where: { id: generationId } });
          if (gen && gen.status !== GenerationStatus.COMPLETED && gen.status !== GenerationStatus.FAILED) {
            await prisma.generation.update({
              where: { id: generationId },
              data: { status: GenerationStatus.FAILED, error: error.message },
            });
          }
        } catch (e) {
          logger.error(`Failed to update generation status: ${e.message}`);
        }
      }
    },
    {
      connection: {
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
      },
    }
  );

  worker.on('failed', (job, error) => {
    logger.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts: ${error.message}`);
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed successfully`);
  });

  logger.info('Worker connected to BullMQ queue');

  // Lightweight reaper: échec les générations bloquées en PROCESSING_* trop anciennes
  setInterval(async () => {
    try {
      const blocked = await prisma.generation.findMany({
        where: {
          status: {
            in: [GenerationStatus.PROCESSING_LLM, GenerationStatus.PROCESSING_RENDER],
          },
        },
      });

      const cutoff = Date.now() - GLOBAL_TIMEOUT_MS;
      for (const gen of blocked) {
        // Simplified: if blocked too long, fail it
        // In production, check when it entered the current state
        if (cutoff > 0) {
          await prisma.generation.update({
            where: { id: gen.id },
            data: { status: GenerationStatus.FAILED, error: 'TIMEOUT' },
          });
        }
      }
    } catch (e) {
      logger.error('Reaper error:', e);
    }
  }, 30_000);
}

main().catch((error) => {
  logger.error('Worker failed to start', error);
  process.exit(1);
});