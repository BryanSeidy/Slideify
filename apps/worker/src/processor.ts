import { Prisma, type PrismaClient } from '@prisma/client';
import type { LLMProvider } from '@slideify/llm';
import { InvalidJSONResponseError } from '@slideify/llm';
import {
  CreditTransactionType,
  GenerationStatus,
  GenerationEventName,
  LLMResponseSchema,
  type LLMResponse,
} from '@slideify/shared';
import { Logger } from './utils/logger';
import {
  acquireForProcessing,
  resetForRetry,
  shouldRetry,
  isTransientError,
  GENERATION_TIMEOUT_MS,
  STALE_PROCESSING_MS,
} from './claim';

const logger = new Logger('worker');

const COMPLETION_STATUSES: GenerationStatus[] = [
  GenerationStatus.PROCESSING_LLM,
  GenerationStatus.PROCESSING_RENDER,
];

class GenerationAlreadyCompletedError extends Error {
  constructor() {
    super('generation already completed');
    this.name = 'GenerationAlreadyCompletedError';
  }
}

class InsufficientCreditsError extends Error {
  constructor() {
    super('NO_CREDITS');
    this.name = 'InsufficientCreditsError';
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === code) ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { code?: string }).code === code)
  );
}

function ledgerUniqueTarget(error: unknown): boolean {
  if (!isPrismaCode(error, 'P2002')) return false;
  const err = error as { meta?: { target?: unknown } };
  const target = err.meta?.target;
  if (Array.isArray(target)) {
    return (
      target.length === 3 &&
      target.includes('userId') &&
      target.includes('type') &&
      target.includes('reference')
    );
  }
  // Fallback for drivers exposing the constraint name.
  const text = JSON.stringify(target ?? '') + (err as { message?: string }).message;
  return /CreditTransaction_userId_type_reference_key/.test(text);
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

export interface ProcessJobInput {
  generationId: string;
  attemptsMade: number;
  maxAttempts: number;
  /** Per-attempt budget override (tests). Defaults to GENERATION_TIMEOUT_MS. */
  budgetMs?: number;
  /** Clock override (tests). */
  now?: () => number;
}

export type ProcessOutcome = 'completed' | 'failed' | 'skipped';

/**
 * Production generation processor (M004/M007).
 * - 'skipped' : poison/missing/terminal/busy delivery (never throws).
 * - 'failed'  : semantic error or exhausted retries, FAILED persisted.
 * - throws    : transient error while retries remain (BullMQ redelivers after
 *               the generation has been reset to QUEUED).
 */
export async function processGeneration(
  db: PrismaClient,
  llm: LLMProvider,
  input: ProcessJobInput,
): Promise<ProcessOutcome> {
  const { generationId, attemptsMade, maxAttempts } = input;
  const now = input.now ?? Date.now;
  const budgetMs = input.budgetMs ?? GENERATION_TIMEOUT_MS;
  const attemptStartedAt = now();

  if (!generationId || typeof generationId !== 'string') {
    logger.error('Poison job: missing generationId, abandoning without retry');
    return 'skipped';
  }

  const acquired = await acquireForProcessing(
    db as never,
    generationId,
    STALE_PROCESSING_MS,
    attemptStartedAt,
  );
  if (acquired !== 'claimed') {
    logger.info(`Generation ${generationId} not claimed (${acquired}), skipping (idempotent)`);
    return 'skipped';
  }

  logger.info(`Processing generation job ${generationId}`);

  const checkBudget = () => {
    if (now() - attemptStartedAt > budgetMs) {
      throw new Error('TIMEOUT');
    }
  };

  const settleOrRetryTransient = async (
    error: unknown,
    terminalCode: string,
  ): Promise<'terminal' | 'settled'> => {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldRetry(attemptsMade, maxAttempts)) {
      const reset = await resetForRetry(db as never, generationId);
      if (!reset) {
        logger.info(`Generation ${generationId} settled concurrently, skipping retry`);
        return 'settled';
      }
      throw error;
    }
    logger.error(`Attempts exhausted for ${generationId}, marking FAILED: ${message}`);
    const updated = await db.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.PROCESSING_LLM, startedAt: fencingStartedAt },
      data: { status: GenerationStatus.FAILED, error: terminalCode },
    });
    if (updated.count === 0) {
      logger.info(`Generation ${generationId} settled concurrently, skipping retry`);
      return 'settled';
    }
    return 'terminal';
  };

  let generation: { id: string; userId: string; sourceText: string; startedAt: Date | null } | null;
  try {
    generation = await db.generation.findUnique({
      where: { id: generationId },
      select: { id: true, userId: true, sourceText: true, startedAt: true },
    });
  } catch (error) {
    const outcome = await settleOrRetryTransient(error, 'LLM_ERROR');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }
  if (!generation) {
    logger.error(`Generation ${generationId} vanished after claim, abandoning`);
    return 'skipped';
  }
  const sourceText: string = generation.sourceText;
  const fencingStartedAt = generation.startedAt ?? new Date(attemptStartedAt);

  // --- Étape LLM ---
  let llmRaw: unknown;
  const generateWithBudget = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    timer.unref?.();
    try {
      return await llm.generate(sourceText, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  try {
    llmRaw = await generateWithBudget();
    checkBudget();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalidJson =
      error instanceof InvalidJSONResponseError ||
      message.includes('Invalid JSON simulated');

    if (invalidJson) {
      // D-14 : exactement un retry de génération, à l'intérieur du job.
      logger.info(`Invalid JSON for ${generationId}, single silent retry`);
      try {
        llmRaw = await generateWithBudget();
        checkBudget();
      } catch (retryError) {
        logger.error(`LLM JSON retry failed for ${generationId}`);
        await db.generation.updateMany({
          where: { id: generationId, status: GenerationStatus.PROCESSING_LLM, startedAt: fencingStartedAt },
          data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
        });
        return 'failed';
      }
    } else if (message === 'TIMEOUT' || isTransientError(error)) {
      const outcome = await settleOrRetryTransient(error, 'TIMEOUT');
      return outcome === 'settled' ? 'skipped' : 'failed';
    } else {
      logger.error(`LLM error for ${generationId}: ${message}`);
      await db.generation.updateMany({
        where: { id: generationId, status: GenerationStatus.PROCESSING_LLM, startedAt: fencingStartedAt },
        data: { status: GenerationStatus.FAILED, error: 'LLM_ERROR' },
      });
      return 'failed';
    }
  }

  // --- Couche 1 : structure (échec terminal, aucun retry, aucun débit) ---
  let validated: LLMResponse;
  const parsed = LLMResponseSchema.safeParse(llmRaw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.path.join('.')).join(',');
    logger.error(`LLM validation failed for ${generationId}: ${issues}`);
    await db.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.PROCESSING_LLM, startedAt: fencingStartedAt },
      data: { status: GenerationStatus.FAILED, error: 'MALFORMED_OUTPUT' },
    });
    return 'failed';
  }
  validated = parsed.data;

  // --- Couche 2 : longueurs (troncature, pas d'échec) ---
  const slides = validated.slides.map((s, i) => ({
    // D-17 : la position dans le tableau fait foi, renumérotation 1..N.
    order: i + 1,
    title: truncateAtWord(s.title.trim(), 60),
    body: truncateAtWord(s.body.trim(), 220),
  }));

  if (slides.some((s) => !s.title || !s.body)) {
    await db.generation.updateMany({
      where: { id: generationId, status: GenerationStatus.PROCESSING_LLM, startedAt: fencingStartedAt },
      data: { status: GenerationStatus.FAILED, error: 'MALFORMED_OUTPUT' },
    });
    return 'failed';
  }

  try {
    checkBudget();
  } catch (error) {
    const outcome = await settleOrRetryTransient(error, 'TIMEOUT');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }

  // --- Transaction de complétition unique : slides + COMPLETED + débit + event ---
  try {
    await db.$transaction(async (tx) => {
      // Passage conditionnel : une seconde complétion échoue et annule
      // toute la transaction (pas de second débit, pas de second event).
      const claimed = await tx.generation.updateMany({
        where: { id: generationId, status: { in: COMPLETION_STATUSES }, startedAt: fencingStartedAt },
        data: { status: GenerationStatus.COMPLETED, completedAt: new Date() },
      });
      if (claimed.count !== 1) {
        throw new GenerationAlreadyCompletedError();
      }

      // Invariant 4 : filet de sécurité, le solde est relu dans le verrou.
      await tx.$queryRawUnsafe(
        'SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE',
        generation.userId,
      );
      const balance = await tx.creditTransaction.aggregate({
        _sum: { amount: true },
        where: { userId: generation.userId },
      });
      if ((balance._sum.amount ?? 0) < 1) {
        throw new InsufficientCreditsError();
      }

      await tx.slide.deleteMany({ where: { generationId } });
      await tx.slide.createMany({
        data: slides.map((s) => ({ generationId, ...s })),
      });
      await tx.generation.update({
        where: { id: generationId },
        data: { slideCount: slides.length },
      });
      await tx.creditTransaction.create({
        data: {
          userId: generation.userId,
          amount: -1,
          type: CreditTransactionType.GENERATION_DEBIT,
          reference: `generation:${generationId}`,
        },
      });
      await tx.generationEvent.createMany({
        data: [
          {
            name: GenerationEventName.USER_ACTIVATED,
            actorId: generation.userId,
            metadata: { generationId },
          },
        ],
        skipDuplicates: true,
      });
    });
  } catch (error) {
    if (error instanceof GenerationAlreadyCompletedError) {
      const current = await db.generation.findUnique({
        where: { id: generationId },
        select: { status: true },
      });
      if (current?.status === GenerationStatus.COMPLETED) {
        logger.info(`Generation ${generationId} already completed (idempotent replay)`);
        return 'completed';
      }
      logger.info(`Generation ${generationId} settled concurrently, skipping`);
      return 'skipped';
    }

    if (ledgerUniqueTarget(error)) {
      // Unicité du ledger : une autre exécution a déjà persisté le débit.
      // On ne force COMPLETED que si les artefacts de complétion sont vérifiés.
      const current = await db.generation.findUnique({
        where: { id: generationId },
        select: { status: true, userId: true },
      });
      const debit = await db.creditTransaction.findFirst({
        where: {
          userId: current?.userId ?? generation.userId,
          type: CreditTransactionType.GENERATION_DEBIT,
          reference: `generation:${generationId}`,
        },
        select: { id: true },
      });
      const slideCount = await db.slide.count({ where: { generationId } });
      if (current?.status === GenerationStatus.COMPLETED || (debit && slideCount > 0)) {
        await db.generation.updateMany({
          where: { id: generationId, status: { in: COMPLETION_STATUSES }, startedAt: fencingStartedAt },
          data: { status: GenerationStatus.COMPLETED, completedAt: new Date() },
        });
        logger.info(`Generation ${generationId} already completed (idempotent replay)`);
        return 'completed';
      }
      await db.generation.updateMany({
        where: { id: generationId, status: { in: COMPLETION_STATUSES }, startedAt: fencingStartedAt },
        data: { status: GenerationStatus.FAILED, error: 'IDEMPOTENCY_CONFLICT' },
      });
      return 'failed';
    }

    // Unicité non liée au ledger : ne jamais la traiter comme une complétion.
    if (isPrismaCode(error, 'P2002')) {
      logger.error(`Unrelated unique constraint violation for ${generationId}`);
      await db.generation.updateMany({
        where: { id: generationId, status: { in: COMPLETION_STATUSES }, startedAt: fencingStartedAt },
        data: { status: GenerationStatus.FAILED, error: 'UNIQUE_CONSTRAINT_VIOLATION' },
      });
      return 'failed';
    }
    if (error instanceof InsufficientCreditsError) {
      await db.generation.updateMany({
        where: { id: generationId, status: { in: COMPLETION_STATUSES }, startedAt: fencingStartedAt },
        data: { status: GenerationStatus.FAILED, error: 'NO_CREDITS' },
      });
      return 'failed';
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Completion transaction failed for ${generationId}: ${message}`);
    const outcome = await settleOrRetryTransient(error, 'TRANSACTION_ERROR');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }

  logger.info(`Generation ${generationId} completed successfully`);
  return 'completed';
}
