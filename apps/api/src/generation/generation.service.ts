import { Injectable, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { config } from '@slideify/config';
import { LLMProvider, createLLMProvider } from '@slideify/llm';
import { renderSlides } from '@slideify/renderer';
import { StorageAdapterFactory } from '@slideify/renderer';
import { CreditTransactionType, GenerationStatus, GenerationEventName, CreditTransaction } from '@slideify/shared';
import { prisma } from '@slideify/shared';

export interface GenerationServiceInterface {
  create(userId: string, sourceText: string): Promise<{ generationId: string; status: GenerationStatus }>;
  getStatus(generationId: string, userId: string): Promise<{ id: string; status: GenerationStatus; slideCount?: number; error?: string; createdAt: Date }>;
  history(userId: string): Promise<any[]>;
}

@Injectable()
export class GenerationService implements OnModuleInit, GenerationServiceInterface {
  private llmProvider: LLMProvider;
  private storage: ReturnType<typeof StorageAdapterFactory.create>;

  constructor(private prisma: PrismaService) {
    // LLM Provider sera initialisé au module init
    this.llmProvider = {} as LLMProvider;
    this.storage = {} as ReturnType<typeof StorageAdapterFactory.create>;
  }

  async onModuleInit() {
    this.llmProvider = createLLMProvider();
    this.storage = StorageAdapterFactory.create();
  }

  async create(userId: string, sourceText: string): Promise<{ generationId: string; status: GenerationStatus }> {
    // Create generation record
    const generation = await this.prisma.generation.create({
      data: {
        userId,
        sourceText,
        status: GenerationStatus.CREATED,
      },
    });

    // Create BullMQ job
    const queue = this.createQueue();
    await queue.add('generation', { generationId: generation.id, sourceText }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });

    return { generationId: generation.id, status: generation.status };
  }

  async getStatus(generationId: string, userId: string): Promise<{ id: string; status: GenerationStatus; slideCount?: number; error?: string; createdAt: Date }> {
    // Verify ownership
    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
      include: { outputs: true },
    });

    if (!generation || generation.userId !== userId) {
      throw new Error('Generation not found or access denied');
    }

    return {
      id: generation.id,
      status: generation.status,
      slideCount: generation.slideCount,
      error: generation.error,
      createdAt: generation.createdAt,
    };
  }

  async history(userId: string): Promise<any[]> {
    return this.prisma.generation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { outputs: true },
    });
  }

  private createQueue() {
    // Simplified - in production would use BullMQ queue instance
    // This is a placeholder for the queue creation pattern
    return {
      add: async (name: string, job: any, options: any) => {
        // Would add to BullMQ queue
      },
    };
  }
}