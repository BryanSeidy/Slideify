import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationStatus } from '@slideify/shared';
import { countWords } from '@slideify/shared';
import {
  GenerationInProgressError,
  NoCreditsError,
  QueueUnavailableError,
} from '../common/errors/http-error';

export interface GenerationServiceInterface {
  create(
    userId: string,
    sourceText: string,
  ): Promise<{ generationId: string; status: GenerationStatus }>;
  getStatus(
    generationId: string,
    userId: string,
  ): Promise<{
    id: string;
    status: GenerationStatus;
    slideCount?: number;
    error?: string;
    createdAt: Date;
  }>;
  history(userId: string): Promise<unknown[]>;
  hasInProgress(userId: string): Promise<boolean>;
  hasCredits(userId: string): Promise<boolean>;
}

const WORD_MIN = 80;
const WORD_MAX = 3000;
const CREDIT_COST = 1;

@Injectable()
export class GenerationService implements GenerationServiceInterface {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('generation') private readonly generationQueue: Queue,
  ) {}

  /**
   * Crée une génération de façon sérialisée par utilisateur.
   * Verrouille la ligne User (SELECT FOR UPDATE) pour garantir :
   *  - pas de solde négatif sous concurrence (P1.2)
   *  - pas de double génération active (P1.1, ceinture + bretelles avec l'index partiel)
   */
  async create(
    userId: string,
    sourceText: string,
  ): Promise<{ generationId: string; status: GenerationStatus }> {
    // Validation du texte (mots, pas caractères)
    const wordCount = countWords(sourceText ?? '');
    if (wordCount < WORD_MIN) {
      throw new GenerationInProgressError(
        `Texte trop court — minimum ${WORD_MIN} mots. Vous manquez de ${
          WORD_MIN - wordCount
        } mot(s).`,
      );
    }
    if (wordCount > WORD_MAX) {
      throw new GenerationInProgressError(
        `Texte trop long — maximum ${WORD_MAX} mots. Vous en avez ${
          wordCount - WORD_MAX
        } de trop.`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      // Verrou sérialisé par utilisateur (SELECT FOR UPDATE sur la ligne User)
      await tx.$queryRawUnsafe(
        'SELECT * FROM "User" WHERE id = $1 FOR UPDATE',
        userId,
      );

      // Vérifier qu'il n'y a pas déjà une génération non terminale
      // (l'index partiel unique est la garde finale au niveau base)
      const activeCount = await tx.generation.count({
        where: {
          userId,
          status: {
            in: [
              GenerationStatus.QUEUED,
              GenerationStatus.PROCESSING_LLM,
              GenerationStatus.PROCESSING_RENDER,
            ],
          },
        },
      });
      if (activeCount > 0) {
        throw new GenerationInProgressError(
          'Une génération est déjà en cours.',
        );
      }

      // Vérifier le solde dans le verrou (P1.2)
      const balance = await tx.creditTransaction.aggregate({
        _sum: { amount: true },
        where: { userId },
      });
      const currentBalance = balance._sum.amount ?? 0;
      if (currentBalance < CREDIT_COST) {
        throw new NoCreditsError();
      }

      // Créer la génération en QUEUED
      const generation = await tx.generation.create({
        data: {
          userId,
          sourceText,
          status: GenerationStatus.QUEUED,
        },
      });

      // Enfiler le job BullMQ (payload minimal : generationId seulement)
      try {
        await this.generationQueue.add(
          'generation',
          { generationId: generation.id },
          {
            jobId: generation.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        );
      } catch (queueError) {
        // Redis indisponible : la génération n'est pas mise en file.
        // Le transaction rollback annule la création. On retourne 503.
        throw new QueueUnavailableError(
          'File de génération temporairement indisponible.',
        );
      }

      return {
        generationId: generation.id,
        status: generation.status as GenerationStatus,
      };
    });
  }

  async getStatus(
    generationId: string,
    userId: string,
  ): Promise<{
    id: string;
    status: GenerationStatus;
    slideCount?: number;
    error?: string;
    createdAt: Date;
  }> {
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
          in: [
            GenerationStatus.QUEUED,
            GenerationStatus.PROCESSING_LLM,
            GenerationStatus.PROCESSING_RENDER,
          ],
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
