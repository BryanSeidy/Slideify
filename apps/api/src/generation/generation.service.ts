import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';
import { GenerationStatus, CreditTransactionType } from '@slideify/shared';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';

export interface GenerationJobData {
  generationId: string;
  sourceText: string;
}

@Injectable()
export class GenerationQueueService {
  private llmProvider: LLMProvider;
  private storage: ReturnType<typeof StorageAdapterFactory.create>;

  constructor(private prisma: PrismaService) {
    this.llmProvider = createLLMProvider();
    this.storage = StorageAdapterFactory.create();
  }

  async process(job: { data: GenerationJobData }): Promise<void> {
    const { generationId, sourceText } = job.data;

    // Step 1: Update status to PROCESSING_LLM
    await this.prisma.generation.update({
      where: { id: generationId },
      data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date() },
    });

    // Step 2: Call LLM
    let llmResponse;
    try {
      llmResponse = await this.llmProvider.generate(sourceText);
    } catch (error) {
      await this.prisma.generation.update({
        where: { id: generationId },
        data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
      });
      return;
    }

    // Step 3: Validate response
    const validation = validateLLMResponse(llmResponse);
    if (!validation.valid) {
      await this.prisma.generation.update({
        where: { id: generationId },
        data: { status: GenerationStatus.FAILED, error: validation.error },
      });
      return;
    }

    // Step 4: Render slides
    let renderedBuffers;
    try {
      renderedBuffers = await renderSlides(llmResponse.slides);
    } catch (error) {
      await this.prisma.generation.update({
        where: { id: generationId },
        data: { status: GenerationStatus.FAILED, error: 'RENDER_ERROR' },
      });
      return;
    }

    // Step 5: Store outputs
    for (let i = 0; i < renderedBuffers.length; i++) {
      await this.storage.upload(
        `${generationId}/slide_${i}.png`,
        renderedBuffers[i],
        'image/png'
      );
    }

    // Step 6: Mark completed and consume credit (transaction)
    await this.prisma.$transaction([
      this.prisma.generation.update({
        where: { id: generationId },
        data: {
          status: GenerationStatus.COMPLETED,
          slideCount: llmResponse.slides.length,
          completedAt: new Date(),
        },
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
  }

  private async getUserId(generationId: string): Promise<string> {
    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
    });
    return generation?.userId || '';
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