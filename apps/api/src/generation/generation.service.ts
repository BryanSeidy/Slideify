import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationStatus } from '@slideify/shared';

export interface GenerationServiceInterface {
  create(userId: string, sourceText: string): Promise<{ generationId: string; status: GenerationStatus }>;
  getStatus(
    generationId: string,
    userId: string,
  ): Promise<{ id: string; status: GenerationStatus; slideCount?: number; error?: string; createdAt: Date }>;
  history(userId: string): Promise<unknown[]>;
  hasInProgress(userId: string): Promise<boolean>;
  hasCredits(userId: string): Promise<boolean>;
}

@Injectable()
export class GenerationService implements GenerationServiceInterface {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('generation') private readonly generationQueue: Queue,
  ) {}

  async create(userId: string, sourceText: string): Promise<{ generationId: string; status: GenerationStatus }> {
    const generation = await this.prisma.generation.create({
      data: {
        userId,
        sourceText,
        status: GenerationStatus.QUEUED,
      },
    });

    await this.generationQueue.add(
      'generation',
      { generationId: generation.id },
      {
        jobId: generation.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      },
    );

    return { generationId: generation.id, status: generation.status as GenerationStatus };
  }

  async getStatus(
    generationId: string,
    userId: string,
  ): Promise<{ id: string; status: GenerationStatus; slideCount?: number; error?: string; createdAt: Date }> {
    const generation = await this.prisma.generation.findUnique({
      where: { id: generationId },
      include: { outputs: true },
    });

    if (!generation || generation.userId !== userId) {
      throw new Error('Generation not found or access denied');
    }

    return {
      id: generation.id,
      status: generation.status as GenerationStatus,
      slideCount: generation.slideCount ?? undefined,
      error: generation.error ?? undefined,
      createdAt: generation.createdAt,
    };
  }

  async history(userId: string): Promise<unknown[]> {
    return this.prisma.generation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { outputs: true },
    });
  }

  async hasInProgress(userId: string): Promise<boolean> {
    const count = await this.prisma.generation.count({
      where: {
        userId,
        status: {
          in: [GenerationStatus.QUEUED, GenerationStatus.PROCESSING_LLM, GenerationStatus.PROCESSING_RENDER],
        },
      },
    });
    return count > 0;
  }

  async hasCredits(userId: string): Promise<boolean> {
    const total = await this.prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId },
    });
    return (total._sum.amount ?? 0) > 0;
  }
}
