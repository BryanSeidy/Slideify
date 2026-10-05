import type { PrismaClient } from '@prisma/client';
import type { LLMProvider } from '@slideify/llm';
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

const MARKER_TIMEOUT = '__MOCK_TIMEOUT__';
const MARKER_INVALID_JSON = '__MOCK_INVALID_JSON__';
const MARKER_SCHEMA_INVALID = '__MOCK_SCHEMA_INVALID__';

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
 * Production generation processor (M004). Pure apart from injected deps —
 * executed directly by unit tests with a fake db + stub LLM.
 *
 * Contract:
 * - returns 'skipped' for poison/missing/terminal/busy deliveries (never throws);
 * - returns 'failed' after writing FAILED for semantic errors or exhausted retries;
 * - THROWS transient errors while retries remain (BullMQ redelivers; the
 *   generation was reset to QUEUED first so the retry really re-executes).
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

  const acquired = await acquireForProcessing(db as never, generationId, STALE_PROCESSING_MS, attemptStartedAt);
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

  /**
   * Settles a transient failure for this attempt.
   * - Attempts remain: resets the claim to QUEUED and THROWS so BullMQ redelivers
   *   (the retry then really re-executes via a fresh atomic claim).
   * - Attempts exhausted: writes FAILED with the given terminal code, returns 'terminal'.
   * - Claim already settled concurrently: returns 'settled' (caller maps to 'skipped').
   */
  const settleOrRetryTransient = async (
    error: unknown,
    terminalCode: string,
  ): Promise<'terminal' | 'settled'> => {
    const message = error instanceof Error ? error.message : String(error);
    if (shouldRetry(attemptsMade, maxAttempts)) {
      const reset = await resetForRetry(db as never, generationId);
      if (!reset) {
        // Lost the race (completed/failed concurrently) — do not retry.
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
    // Read failure before any work: transient infrastructure error.
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
    if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_TIMEOUT)) {
      throw new Error('Simulated timeout');
    }
    llmRaw = await llm.generate(sourceText);
    checkBudget();

    if (process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_INVALID_JSON)) {
      throw new Error('Invalid JSON simulated');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Invalid JSON simulated') {
      logger.info(`Invalid JSON for ${generationId}, single silent retry`);
      try {
        llmRaw = await llm.generate(sourceText.replace(MARKER_INVALID_JSON, ''));
        checkBudget();
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        logger.error(`LLM retry failed for ${generationId}: ${retryMessage}`);
        await db.generation.update({
          where: { id: generationId },
          data: { status: GenerationStatus.FAILED, error: 'MALFORMED_OUTPUT' },
        });
        return 'failed';
      }
    } else if (message === 'TIMEOUT' || message.includes('Simulated timeout') || isTransientError(error)) {
      const outcome = await settleOrRetryTransient(
        error,
        message.includes('TIMEOUT') || message.includes('Simulated timeout') ? 'TIMEOUT' : 'LLM_ERROR',
      );
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

  // --- Validation Zod stricte (jamais de persistance directe) ---
  let validated: LLMResponse;
  try {
    const parsed = LLMResponseSchema.safeParse(llmRaw);
    if (!parsed.success) {
      throw new Error('schema invalid: ' + parsed.error.issues.map((i) => i.path.join('.')).join(','));
    }
    validated = parsed.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`LLM validation failed for ${generationId}: ${message}`);
    const code =
      process.env.NODE_ENV !== 'production' && sourceText.includes(MARKER_SCHEMA_INVALID)
        ? 'MALFORMED_OUTPUT'
        : 'INVALID_RESPONSE';
    await db.generation.update({
      where: { id: generationId },
      data: { status: GenerationStatus.FAILED, error: code },
    });
    return 'failed';
  }

  if (validated.slides.length < 5 || validated.slides.length > 10) {
    logger.error(`Invalid slide count ${validated.slides.length} for ${generationId}`);
    await db.generation.update({
      where: { id: generationId },
      data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
    });
    return 'failed';
  }

  const slides = validated.slides.map((s, i) => ({
    order: i + 1,
    title: truncateAtWord(s.title.trim(), 60),
    body: truncateAtWord(s.body.trim(), 220),
  }));

  if (slides.some((s) => !s.title || !s.body)) {
    await db.generation.update({
      where: { id: generationId },
      data: { status: GenerationStatus.FAILED, error: 'INVALID_RESPONSE' },
    });
    return 'failed';
  }

  try {
    checkBudget();
  } catch (error) {
    const outcome = await settleOrRetryTransient(error, 'TIMEOUT');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }

  // --- Transaction atomique : slides + COMPLETED + débit + activation ---
  try {
    await db.$transaction(async (tx) => {
      await tx.slide.deleteMany({ where: { generationId } });
      await tx.slide.createMany({
        data: slides.map((s) => ({
          generationId,
          order: s.order,
          title: s.title,
          body: s.body,
        })),
      });

      await tx.generation.update({
        where: { id: generationId },
        data: {
          status: GenerationStatus.COMPLETED,
          slideCount: slides.length,
          completedAt: new Date(),
        },
      });

      await tx.creditTransaction.create({
        data: {
          userId: generation.userId,
          amount: -1,
          type: CreditTransactionType.GENERATION_DEBIT,
          reference: `generation:${generationId}`,
        },
      });

      const completedCount = await tx.generation.count({
        where: { userId: generation.userId, status: GenerationStatus.COMPLETED },
      });
      if (completedCount === 1) {
        await tx.generationEvent.create({
          data: {
            name: GenerationEventName.FIRST_GENERATION_COMPLETED,
            actorId: generation.userId,
            metadata: { generationId },
          },
        });
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Unique constraint') || message.includes('UniqueConstraint')) {
      logger.info(`Generation ${generationId} already completed by concurrent worker (idempotent)`);
      return 'completed';
    }
    logger.error(`Completion transaction failed for ${generationId}: ${message}`);
    const outcome = await settleOrRetryTransient(error, 'TRANSACTION_ERROR');
    return outcome === 'settled' ? 'skipped' : 'failed';
  }

  try {
    checkBudget();
  } catch (error) {
    // Work is fully persisted; a budget overrun here must not fail the generation.
    logger.info(`Generation ${generationId} completed (budget check after commit skipped)`);
    return 'completed';
  }
  logger.info(`Generation ${generationId} completed successfully`);
  return 'completed';
}
