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

function isCompletionUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if (!isPrismaCode(error, 'P2002')) return false;
  const err = error as Error & { meta?: { target?: unknown } };
  const target = JSON.stringify(err.meta?.target ?? '');
  // Toute unicité touchée par la transaction de complétion signifie qu'une
  // autre exécution a déjà persisté le même résultat.
  return /CreditTransaction|generation:|Slide|GenerationEvent/.test(target + (err.message ?? ''));
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
    await db.generation.update({
      where: { id: generationId },
      data: { status: GenerationStatus.FAILED, error: terminalCode },
    });
    return 'terminal';
  };

  let generation: { id: string; userId: string; sourceText: string } | null;
  try {
    generation = await db.generation.findUnique({ where: { id: generationId } });
  } catch (error) {
    const outcome = await settleOrRetryTransient(error, 'LLM_ERROR');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }
  if (!generation) {
    logger.error(`Generation ${generationId} vanished after claim, abandoning`);
    return 'skipped';
  }
  const sourceText: string = generation.sourceText;

  // --- Étape LLM ---
  let llmRaw: unknown;
  try {
    llmRaw = await llm.generate(sourceText);
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
        llmRaw = await llm.generate(sourceText);
        checkBudget();
      } catch (retryError) {
        logger.error(`LLM JSON retry failed for ${generationId}`);
        await db.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
        });
        return 'failed';
      }
    } else if (message === 'TIMEOUT' || isTransientError(error)) {
      const outcome = await settleOrRetryTransient(error, 'TIMEOUT');
      return outcome === 'settled' ? 'skipped' : 'failed';
    } else {
      logger.error(`LLM error for ${generationId}: ${message}`);
      await db.generation.update({
        where: { id: generationId },
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
    await db.generation.update({
      where: { id: generationId },
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
    await db.generation.update({
      where: { id: generationId },
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
        where: { id: generationId, status: { in: COMPLETION_STATUSES } },
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
      await tx.generationEvent.create({
        data: {
          name: GenerationEventName.USER_ACTIVATED,
          actorId: generation.userId,
          metadata: { generationId },
        },
      });
    });
  } catch (error) {
    if (error instanceof GenerationAlreadyCompletedError || isCompletionUniqueViolation(error)) {
      // La transaction a pu être annulée APRÈS le passage en COMPLETED (unicité
      // du ledger). On repasse la ligne en terminal hors transaction pour ne
      // jamais laisser un doublon de complétion bloquer le réconciliateur.
      await db.generation.updateMany({
        where: { id: generationId, status: { in: COMPLETION_STATUSES } },
        data: { status: GenerationStatus.COMPLETED, completedAt: new Date() },
      });
      logger.info(`Generation ${generationId} already completed (idempotent replay)`);
      return 'completed';
    }
    if (error instanceof InsufficientCreditsError) {
      await db.generation.update({
        where: { id: generationId },
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
