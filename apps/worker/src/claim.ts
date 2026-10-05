import { GenerationStatus } from '@slideify/shared';

/**
 * Single-consumer claim + retry policy for the generation queue (M004.2 P0#2).
 *
 * Invariant kept: at most one worker owns a generation at a time.
 * - First delivery claims QUEUED -> PROCESSING_LLM atomically (updateMany, count === 1).
 * - A BullMQ retry after a *transient* failure finds the generation back in QUEUED
 *   (the worker resets it before rethrowing), so the retry really re-executes.
 * - A redelivery finding a *fresh* PROCESSING_* state is skipped: another worker
 *   (or the same job still running) owns it.
 * - A redelivery finding a *stale* PROCESSING_* state (worker died without
 *   resetting) may reclaim it — BullMQ only redelivers after the lock is lost,
 *   so the previous owner is gone.
 */

export const MAX_ATTEMPTS = 3;

/** A PROCESSING_* state older than this is considered orphaned and reclaimable. */
export const STALE_PROCESSING_MS = 180_000;

/** Per-attempt processing budget, measured from each attempt start (never global). */
export const GENERATION_TIMEOUT_MS = 90_000;

export interface ClaimRecord {
  status: string;
  startedAt: Date | null;
}

export interface ClaimDb {
  generation: {
    updateMany(args: {
      where: { id: string; status?: string };
      data: { status: string; startedAt?: Date };
    }): Promise<{ count: number }>;
    findUnique(args: { where: { id: string } }): Promise<ClaimRecord | null>;
  };
}

export type AcquireOutcome = 'claimed' | 'skip-missing' | 'skip-terminal' | 'skip-busy';

const TERMINAL = new Set<string>([GenerationStatus.COMPLETED, GenerationStatus.FAILED]);

const PROCESSING = new Set<string>([GenerationStatus.PROCESSING_LLM, GenerationStatus.PROCESSING_RENDER]);

export async function acquireForProcessing(
  db: ClaimDb,
  generationId: string,
  staleMs: number = STALE_PROCESSING_MS,
  now: number = Date.now(),
): Promise<AcquireOutcome> {
  const claimed = await db.generation.updateMany({
    where: { id: generationId, status: GenerationStatus.QUEUED },
    data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date(now) },
  });
  if (claimed.count === 1) return 'claimed';

  const current = await db.generation.findUnique({ where: { id: generationId } });
  if (!current) return 'skip-missing';
  if (TERMINAL.has(current.status)) return 'skip-terminal';

  if (PROCESSING.has(current.status) && current.startedAt) {
    const age = now - new Date(current.startedAt).getTime();
    if (age > staleMs) {
      const reclaimed = await db.generation.updateMany({
        where: { id: generationId, status: current.status },
        data: { status: GenerationStatus.PROCESSING_LLM, startedAt: new Date(now) },
      });
      return reclaimed.count === 1 ? 'claimed' : 'skip-busy';
    }
  }
  return 'skip-busy';
}

/**
 * Release a PROCESSING_LLM claim back to QUEUED so a BullMQ retry can re-claim it.
 * Conditional: if the row is no longer PROCESSING_LLM (e.g. completed
 * concurrently), it is left untouched and false is returned.
 */
export async function resetForRetry(db: ClaimDb, generationId: string): Promise<boolean> {
  const reset = await db.generation.updateMany({
    where: { id: generationId, status: GenerationStatus.PROCESSING_LLM },
    data: { status: GenerationStatus.QUEUED },
  });
  return reset.count === 1;
}

/** True while BullMQ still has attempts left for this job (attemptsMade is 0-based). */
export function shouldRetry(attemptsMade: number, maxAttempts: number = MAX_ATTEMPTS): boolean {
  return attemptsMade + 1 < maxAttempts;
}

export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('Simulated timeout') ||
    message.includes('TIMEOUT') ||
    message.includes('ECONNRESET') ||
    message.includes('ETIMEDOUT') ||
    message.includes('429') ||
    message.includes('500') ||
    message.includes('502') ||
    message.includes('503')
  );
}
