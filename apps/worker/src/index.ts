import { Queue, Worker } from 'bullmq';
import { config } from '@slideify/config';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';
import { PrismaService } from '@slideify/schema';
import { GenerationStatus, CreditTransactionType, CreditTransaction, GenerationEventName } from '@slideify/shared';
import { Logger } from './utils/logger';

const logger = new Logger('worker');

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

      try {
        // Step 1: Verify generation exists and is in CREATED state
        const generation = await prisma.generation.findUnique({
          where: { id: generationId },
        });

        if (!generation) {
          logger.error(`Generation ${generationId} not found`);
          return;
        }

        if (generation.status !== GenerationStatus.CREATED) {
          logger.warn(`Generation ${generationId} already in state ${generation.status}, skipping`);
          return;
        }

        // Step 2: Update to PROCESSING_LLM
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
        });

        // Step 3: Call LLM via provider
        let llmResult;
        try {
          llmResult = await createLLMProvider().generate(sourceText);
        } catch (error) {
          logger.error(`LLM error for generation ${generationId}: ${error.message}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
          });
          return;
        }

        // Step 4: Validate LLM response using Zod from shared
        let validated;
        try {
          const { LLMResponseSchema } = await import('@slideify/shared');
          validated = LLMResponseSchema.parse(llmResult);
        } catch (error) {
          logger.error(`LLM response validation failed for generation ${generationId}: ${error.message}`);
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'VALIDATION_ERROR' },
          });
          return;
        }

        // Step 5: Render slides
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

        // Step 6: Store outputs in transaction
        await prisma.$transaction(async (tx) => {
          // Persist slides
          for (let i = 0; i < buffers.length; i++) {
            await StorageAdapterFactory.create().upload(
              `${generationId}/slide_${i}.png`,
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

          // Debit credit - only on success
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

        try {
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: error.message },
          });
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
}

main().catch((error) => {
  logger.error('Worker failed to start', error);
  process.exit(1);
});