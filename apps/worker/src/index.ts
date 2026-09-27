import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';
import { GenerationStatus, CreditTransactionType } from '@slideify/shared';
import { GenerationJob } from '@slideify/shared';
import { Logger } from './utils/logger';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';

const logger = new Logger('worker');

export async function main() {
  logger.info('Starting Slideify generation worker...');

  const prisma = new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query'] : [],
  });
  await prisma.$connect();

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
      const { generationId, sourceText }: GenerationJob = job.data;
      const llmProvider = createLLMProvider();
      const storage = StorageAdapterFactory.create();

      try {
        // Step 1: Update to PROCESSING_LLM
        await prisma.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
        });

        // Step 2: Call LLM
        let llmResult;
        try {
          llmResult = await llmProvider.generate(sourceText);
        } catch (error) {
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
          });
          return;
        }

        // Step 3: Validate response
        const validation = validateLLMResponse(llmResult);
        if (!validation.valid) {
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: validation.error },
          });
          return;
        }

        // Step 4: Render
        let buffers;
        try {
          buffers = await renderSlides(llmResult.slides);
        } catch (error) {
          await prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.FAILED, error: 'RENDER_ERROR' },
          });
          return;
        }

        // Step 5: Store
        for (let i = 0; i < buffers.length; i++) {
          await storage.upload(`${generationId}/slide_${i}.png`, buffers[i], 'image/png');
        }

        // Step 6: Mark complete + consume credit (transaction)
        await prisma.$transaction([
          prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.COMPLETED, slideCount: llmResult.slides.length, completedAt: new Date() },
          }),
          prisma.creditTransaction.create({
            data: {
              userId: await getUserId(prisma, generationId),
              amount: -1,
              type: CreditTransactionType.GENERATION_DEBIT,
              reference: generationId,
            },
          }),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.error(message);
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
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts: ${message}`);
  });

  worker.on('completed', (job) => {
    logger.info(`Job ${job.id} completed successfully`);
  });

  logger.info('Worker connected to BullMQ queue');
}

function validateLLMResponse(response: any): { valid: boolean; error?: string } {
  if (!response?.slides || !Array.isArray(response.slides) || response.slides.length < 5) {
    return { valid: false, error: 'INVALID_RESPONSE' };
  }
  if (response.slides.length > 10) {
    return { valid: false, error: 'TOO_MANY_SLIDES' };
  }
  return { valid: true };
}

async function getUserId(prisma: PrismaClient, generationId: string): Promise<string> {
  const gen = await prisma.generation.findUnique({ where: { id: generationId } });
  return gen?.userId || '';
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : 'Unknown error';
  logger.error('Worker failed to start', error);
  process.exit(1);
});