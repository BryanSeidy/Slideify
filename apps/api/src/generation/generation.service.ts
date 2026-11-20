import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { GenerationStatus, countWords } from '@slideify/shared';
import {
  GenerationInProgressError,
  InputTooLongError,
  InputTooShortError,
  NoCreditsError,
  NotFoundError,
  QueueUnavailableError,
} from '../common/errors/http-error';

export interface GenerationStatusResult {
  id: string;
  status: GenerationStatus;
  slideCount?: number;
  error?: string;
  sourceText?: string;
  createdAt: Date;
}

export interface GenerationServiceInterface {
  create(
    userId: string,
    sourceText: string,
  ): Promise<{ generationId: string; status: GenerationStatus }>;
  getStatus(generationId: string, userId: string): Promise<GenerationStatusResult>;
  history(userId: string): Promise<unknown[]>;
  hasInProgress(userId: string): Promise<boolean>;
  hasCredits(userId: string): Promise<boolean>;
}

const WORD_MIN = 80;
const WORD_MAX = 3000;
const CREDIT_COST = 1;
const QUEUE_ADD_TIMEOUT_MS = 2000;

const ACTIVE_STATUSES: GenerationStatus[] = [
  GenerationStatus.QUEUED,
  GenerationStatus.PROCESSING_LLM,
  GenerationStatus.PROCESSING_RENDER,
];

function isPrismaKnownError(error: unknown, code: string): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === code)
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

@Injectable()
export class GenerationService implements GenerationServiceInterface {
  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('generation') private readonly generationQueue: Queue,
  ) {}

  /**
   * Crée la génération dans une transaction verrouillée par utilisateur,
   * PUIS l'enfile hors transaction. Si Redis est indisponible, la ligne est
   * repassée en FAILED/QUEUE_UNAVAILABLE : l'utilisateur n'est pas bloqué par
   * l'index partiel "une seule génération active".
   */
  async create(
    userId: string,
    sourceText: string,
  ): Promise<{ generationId: string; status: GenerationStatus }> {
    const wordCount = countWords(sourceText ?? '');
    if (wordCount < WORD_MIN) {
      throw new InputTooShortError(
        `Texte trop court — minimum ${WORD_MIN} mots. Vous manquez de ${
          WORD_MIN - wordCount
        } mot(s).`,
      );
    }
    if (wordCount > WORD_MAX) {
      throw new InputTooLongError(
        `Texte trop long — maximum ${WORD_MAX} mots. Vous en avez ${
          wordCount - WORD_MAX
        } de trop.`,
      );
    }

    const generation = await this.prisma.$transaction(async (tx) => {
      // Verrou sérialisé par utilisateur (SELECT FOR UPDATE).
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
        userId,
      );

      const active = await tx.generation.findFirst({
        where: { userId, status: { in: ACTIVE_STATUSES } },
        select: { id: true },
      });
      if (active) {
        throw new GenerationInProgressError(
          'Une génération est déjà en cours.',
          active.id,
        );
      }

      const balance = await tx.creditTransaction.aggregate({
        _sum: { amount: true },
        where: { userId },
      });
      if ((balance._sum.amount ?? 0) < CREDIT_COST) {
        throw new NoCreditsError();
      }

      try {
        return await tx.generation.create({
          data: {
            userId,
            sourceText,
            status: GenerationStatus.QUEUED,
          },
        });
      } catch (error) {
        // L'index partiel est la garde finale sous concurrence réelle.
        if (isPrismaKnownError(error, 'P2002')) {
          const current = await tx.generation.findFirst({
            where: { userId, status: { in: ACTIVE_STATUSES } },
            select: { id: true },
          });
          throw new GenerationInProgressError(
            'Une génération est déjà en cours.',
            current?.id,
          );
        }
        throw error;
      }
    });

    // Enfilage APRÈS commit : aucun job ne peut référencer une ligne
    // inexistante (rollback) ni bloquer la transaction PostgreSQL sur Redis.
    try {
      await withTimeout(
        this.generationQueue.add(
          'generation',
          { generationId: generation.id },
          {
            jobId: generation.id,
            attempts: 3,
            backoff: { type: 'exponential', delay: 2000 },
          },
        ),
        QUEUE_ADD_TIMEOUT_MS,
        'queue.add timeout',
      );
    } catch {
      await this.markQueueUnavailable(generation.id);
      throw new QueueUnavailableError();
    }

    return {
      generationId: generation.id,
      status: generation.status as GenerationStatus,
    };
  }

  private async markQueueUnavailable(generationId: string): Promise<void> {
    try {
      await this.prisma.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.QUEUED },
        data: { status: GenerationStatus.FAILED, error: 'QUEUE_UNAVAILABLE' },
      });
    } catch (error) {
      // Le réconciliateur (5 min) reprendra la ligne si cette écriture échoue.
      console.error(`Unable to mark generation ${generationId} as QUEUE_UNAVAILABLE`, error);
    }
  }

  async getStatus(
    generationId: string,
    userId: string,
  ): Promise<GenerationStatusResult> {
    const generation = await this.prisma.generation.findFirst({
      where: { id: generationId, userId },
      select: {
        id: true,
        status: true,
        slideCount: true,
        error: true,
        createdAt: true,
        sourceText: true,
      },
    });

    if (!generation) {
      // Même réponse pour une ligne inexistante et pour une ligne d'autrui.
      throw new NotFoundError('Génération introuvable.');
    }

    return {
      id: generation.id,
      status: generation.status as GenerationStatus,
      slideCount: generation.slideCount ?? undefined,
      error: generation.error ?? undefined,
      // D-02 : sourceText n'est renvoyé qu'au propriétaire d'une génération
      // FAILED, pour préremplir "Réessayer" après rechargement de page.
      ...(generation.status === GenerationStatus.FAILED
        ? { sourceText: generation.sourceText }
        : {}),
      createdAt: generation.createdAt,
    };
  }

  async history(userId: string): Promise<unknown[]> {
    const generations = await this.prisma.generation.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        status: true,
        slideCount: true,
        error: true,
        createdAt: true,
        completedAt: true,
        outputs: { select: { expiresAt: true } },
        slides: {
          orderBy: { order: 'asc' },
          take: 1,
          select: { title: true },
        },
      },
    });

    const now = Date.now();
    return generations.map((g) => ({
      id: g.id,
      status: g.status,
      slideCount: g.slideCount,
      error: g.error,
      createdAt: g.createdAt,
      completedAt: g.completedAt,
      title: g.slides[0]?.title ?? null,
      filesAvailable: g.outputs.some(
        (o) => !o.expiresAt || o.expiresAt.getTime() > now,
      ),
      // sourceText est volontairement absent de la liste (E-18).
    }));
  }

  async hasInProgress(userId: string): Promise<boolean> {
    const count = await this.prisma.generation.count({
      where: { userId, status: { in: ACTIVE_STATUSES } },
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
