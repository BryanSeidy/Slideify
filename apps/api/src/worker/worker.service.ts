import { Injectable, OnModuleInit } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';
import { GenerationStatus, CreditTransactionType } from '@slideify/shared';
import { GenerationJob } from '@slideify/shared';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';

@Injectable()
export class WorkerService implements OnModuleInit {
  private worker: Worker;

  constructor(
    private prisma: PrismaService,
  ) {}

  onModuleInit() {
    this.worker = new Worker(
      'generation',
      async (job) => {
        const { generationId, sourceText }: GenerationJob = job.data;
        const llmProvider = createLLMProvider();
        const storage = StorageAdapterFactory.create();

        try {
          // Step 1: Update to PROCESSING_LLM
          await this.prisma.generation.update({
            where: { id: generationId },
            data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
          });

          // Step 2: Call LLM
          let llmResult;
          try {
            llmResult = await llmProvider.generate(sourceText);
          } catch (error) {
            await this.prisma.generation.update({
              where: { id: generationId },
              data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
            });
            return;
          }

          // Step 3: Validate response
          const validation = validateLLMResponse(llmResult);
          if (!validation.valid) {
            await this.prisma.generation.update({
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
            await this.prisma.generation.update({
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
          await this.prisma.$transaction([
            this.prisma.generation.update({
              where: { id: generationId },
              data: { status: GenerationStatus.COMPLETED, slideCount: llmResult.slides.length, completedAt: new Date() },
            }),
            this.prisma.creditTransaction.create({
              data: {
                userId: await this.getUserId(generationId),
                amount: -1,
                type: CreditTransactionType.GENERATION_DEBIT,
                reference: generationId,
              },
            }),
          ]);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
          console.error(`Job ${job.id} failed: ${message}`);
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
  }

  private async getUserId(generationId: string): Promise<string> {
    const gen = await this.prisma.generation.findUnique({ where: { id: generationId } });
    return gen?.userId || '';
  }
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