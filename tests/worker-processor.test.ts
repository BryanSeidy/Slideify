import type { PrismaClient } from '@prisma/client';

// Env avant tout import de @slideify/llm (le factory lit la config au chargement).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/slideify_test';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'unit-test-secret-0123456789abcdef';
process.env.AI_PROVIDER = 'mock';

// Production units under test (real code paths, fake infrastructure).
// NOTE: jest sets NODE_ENV=test when unset; mock markers stay active here.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { processGeneration } = require('../apps/worker/src/processor');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const claim = require('../apps/worker/src/claim');

type GenRow = {
  id: string;
  userId: string;
  sourceText: string;
  status: string;
  startedAt: Date | null;
  slideCount: number | null;
  error: string | null;
  completedAt: Date | null;
};

type SlideRow = { order: number; title: string; body: string };

function validSlides(n = 5) {
  return Array.from({ length: n }, (_, i) => ({
    order: i + 1,
    title: `Title ${i + 1}`,
    body: `Body of slide ${i + 1} with enough content.`,
  }));
}

/** In-memory Prisma stand-in with real uniqueness semantics (P2002-style errors). */
function makeFakeDb() {
  const generations = new Map<string, GenRow>();
  const slides = new Map<string, SlideRow[]>();
  const debits: Array<{ userId: string; amount: number; type: string; reference: string }> = [];
  const events: Array<{ name: string; actorId: string; metadata: unknown }> = [];

  const generation = {
    updateMany: async ({
      where,
      data,
    }: {
      where: { id: string; status?: string | { in: string[] }; startedAt?: Date | null };
      data: Partial<GenRow>;
    }) => {
      const g = generations.get(where.id);
      if (!g) return { count: 0 };
      if (typeof where.status === 'string' && g.status !== where.status) return { count: 0 };
      if (
        where.status &&
        typeof where.status === 'object' &&
        !where.status.in.includes(g.status)
      ) {
        return { count: 0 };
      }
      if (where.startedAt !== undefined) {
        const current = g.startedAt ? g.startedAt.getTime() : null;
        const expected = where.startedAt ? where.startedAt.getTime() : null;
        if (current !== expected) return { count: 0 };
      }
      Object.assign(g, data);
      return { count: 1 };
    },
    findUnique: async ({ where }: { where: { id: string } }) => generations.get(where.id) ?? null,
    findFirst: async ({ where }: { where: { id?: string; userId?: string; status?: unknown } }) => {
      for (const g of generations.values()) {
        if (where.id && g.id !== where.id) continue;
        if (where.userId && g.userId !== where.userId) continue;
        return g;
      }
      return null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<GenRow> }) => {
      const g = generations.get(where.id);
      if (!g) throw new Error('Record not found');
      Object.assign(g, data);
      return g;
    },
    count: async ({ where }: { where: { userId: string; status: string } }) =>
      [...generations.values()].filter((g) => g.userId === where.userId && g.status === where.status).length,
  };

  const slide = {
    count: async ({ where }: { where: { generationId: string } }) =>
      (slides.get(where.generationId) ?? []).length,
    deleteMany: async ({ where }: { where: { generationId: string } }) => {
      slides.delete(where.generationId);
      return { count: 0 };
    },
    createMany: async ({ data }: { data: Array<SlideRow & { generationId: string }> }) => {
      const byGen = new Map<string, Set<number>>();
      for (const s of data) {
        let set = byGen.get(s.generationId);
        if (!set) {
          set = new Set((slides.get(s.generationId) ?? []).map((x) => x.order));
          byGen.set(s.generationId, set);
        }
        if (set.has(s.order)) throw new Error('Unique constraint failed on Slide(generationId, order)');
        set.add(s.order);
      }
      for (const s of data) {
        const list = slides.get(s.generationId) ?? [];
        list.push({ order: s.order, title: s.title, body: s.body });
        slides.set(s.generationId, list);
      }
      return { count: data.length };
    },
  };

  const creditTransaction = {
    findFirst: async ({ where }: { where: { userId?: string; type?: string; reference?: string } }) =>
      debits.find(
        (d) =>
          (where.userId === undefined || d.userId === where.userId) &&
          (where.type === undefined || d.type === where.type) &&
          (where.reference === undefined || d.reference === where.reference),
      ) ?? null,
    aggregate: async () => ({ _sum: { amount: debits.reduce((s, d) => s + d.amount, 0) } }),
    create: async (args: { data: { userId: string; amount: number; type: string; reference: string } }) => {
      const d = args.data;
      if (debits.some((x) => x.userId === d.userId && x.type === d.type && x.reference === d.reference)) {
        const err = new Error(
          'Unique constraint failed on the fields: (`userId`,`type`,`reference`)',
        ) as Error & { code?: string; meta?: { target?: string[] } };
        err.code = 'P2002';
        err.meta = { target: ['userId', 'type', 'reference'] };
        throw err;
      }
      debits.push(d);
      return d;
    },
  };

  const generationEvent = {
    create: async ({ data }: { data: { name: string; actorId: string; metadata: unknown } }) => {
      if (events.some((e) => e.actorId === data.actorId && e.name === data.name)) {
        const err = new Error('Unique constraint failed on GenerationEvent(actorId, name)');
        (err as { code?: string }).code = 'P2002';
        (err as { meta?: unknown }).meta = { target: ['actorId', 'name'] };
        throw err;
      }
      events.push(data);
      return data;
    },
    createMany: async ({
      data,
      skipDuplicates,
    }: {
      data: Array<{ name: string; actorId: string; metadata: unknown }>;
      skipDuplicates?: boolean;
    }) => {
      for (const row of data) {
        if (
          skipDuplicates &&
          events.some((e) => e.actorId === row.actorId && e.name === row.name)
        ) {
          continue;
        }
        if (
          !skipDuplicates &&
          events.some((e) => e.actorId === row.actorId && e.name === row.name)
        ) {
          const err = new Error('Unique constraint failed on GenerationEvent(actorId, name)');
          (err as { code?: string }).code = 'P2002';
          (err as { meta?: unknown }).meta = { target: ['actorId', 'name'] };
          throw err;
        }
        events.push(row);
      }
      return { count: data.length };
    },
  };

  const db = {
    generation,
    slide,
    creditTransaction: {
      ...creditTransaction,
      aggregate: async ({ where }: { where: { userId: string } }) => ({
        _sum: {
          amount: debits
            .filter((d) => d.userId === where.userId)
            .reduce((sum, d) => sum + d.amount, 3), // 3 crédits de bienvenue
        },
      }),
    },
    generationEvent,
    $queryRawUnsafe: async () => [],
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      // Snapshot for rollback semantics (mirrors real transaction atomicity).
      const snapGen = new Map(generations);
      const snapSlides = new Map([...slides.entries()].map(([k, v]) => [k, [...v]] as const));
      const snapDebits = [...debits];
      const snapEvents = [...events];
      try {
        return await fn({
          generation,
          slide,
          creditTransaction: db.creditTransaction,
          generationEvent,
          $queryRawUnsafe: db.$queryRawUnsafe,
        });
      } catch (e) {
        generations.clear();
        for (const [k, v] of snapGen) generations.set(k, v);
        slides.clear();
        for (const [k, v] of snapSlides) slides.set(k, [...v]);
        debits.length = 0;
        debits.push(...snapDebits);
        events.length = 0;
        events.push(...snapEvents);
        throw e;
      }
    },
  };

  return { db: db as unknown as PrismaClient, generations, slides, debits, events };
}

function seedGeneration(ctx: ReturnType<typeof makeFakeDb>, status = 'QUEUED', startedAt: Date | null = null) {
  const id = `gen_${Math.random().toString(36).slice(2)}`;
  ctx.generations.set(id, {
    id,
    userId: 'user_1',
    sourceText: 'word '.repeat(120).trim(),
    status,
    startedAt,
    slideCount: null,
    error: null,
    completedAt: null,
  });
  return id;
}

function stubLlm(behaviors: Array<'ok' | { throw: Error } | { invalidSchema: true }>, validN = 5) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async generate() {
      calls += 1;
      const b = behaviors[calls - 1] ?? 'ok';
      if (typeof b === 'object' && 'throw' in b) throw b.throw;
      if (typeof b === 'object' && 'invalidSchema' in b) {
        return { slides: validSlides(4), meta: { slide_count: 4, source_language: 'en' } };
      }
      return { slides: validSlides(validN), meta: { slide_count: validN, source_language: 'en' } };
    },
  };
}

describe('P0#2 — first treatment executes and completes', () => {
  it('QUEUED -> COMPLETED with 5 ordered slides, exactly 1 debit, 1 activation', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const llm = stubLlm(['ok']);

    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(outcome).toBe('completed');
    expect(llm.calls).toBe(1);
    expect(ctx.generations.get(id)?.status).toBe('COMPLETED');
    expect(ctx.slides.get(id)?.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
    expect(ctx.debits.filter((d) => d.reference === `generation:${id}`)).toHaveLength(1);
    expect(ctx.events.filter((e) => e.name === 'user_activated')).toHaveLength(1);
  });
});

describe('P0#2 — transient error triggers a REAL retry that re-executes', () => {
  it('timeout -> reset to QUEUED + throw; retry re-runs LLM and completes with still exactly 1 debit', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const llm = stubLlm([{ throw: new Error('Simulated timeout') }, 'ok']);

    await expect(
      processGeneration(ctx.db, llm as never, { generationId: id, attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toThrow('Simulated timeout');

    // The retry must find QUEUED again (the P0#2 regression left PROCESSING_LLM here).
    expect(ctx.generations.get(id)?.status).toBe('QUEUED');
    expect(ctx.debits).toHaveLength(0);
    expect(ctx.slides.get(id)).toBeUndefined();

    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 1,
      maxAttempts: 3,
    });

    expect(outcome).toBe('completed');
    expect(llm.calls).toBe(2); // second treatment REALLY executed
    expect(ctx.slides.get(id)).toHaveLength(5); // no duplicates
    expect(ctx.debits.filter((d) => d.reference === `generation:${id}`)).toHaveLength(1);
    expect(ctx.events.filter((e) => e.name === 'user_activated')).toHaveLength(1);
  });

  it('persistent transient -> FAILED after attempts exhausted, 0 debit, 0 slides', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const mkLlm = () => stubLlm([{ throw: new Error('Simulated timeout') }]);

    await expect(
      processGeneration(ctx.db, mkLlm() as never, { generationId: id, attemptsMade: 0, maxAttempts: 3 }),
    ).rejects.toThrow();
    await expect(
      processGeneration(ctx.db, mkLlm() as never, { generationId: id, attemptsMade: 1, maxAttempts: 3 }),
    ).rejects.toThrow();
    const outcome = await processGeneration(ctx.db, mkLlm() as never, {
      generationId: id,
      attemptsMade: 2,
      maxAttempts: 3,
    });

    expect(outcome).toBe('failed');
    expect(ctx.generations.get(id)?.status).toBe('FAILED');
    expect(ctx.debits).toHaveLength(0);
    expect(ctx.slides.get(id)).toBeUndefined();
  });
});

describe('P0#2 — semantic errors never retry and never debit', () => {
  it('schema-invalid output -> FAILED/MALFORMED_OUTPUT immediately, LLM called once', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const llm = stubLlm([{ invalidSchema: true }]);

    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(outcome).toBe('failed');
    expect(llm.calls).toBe(1);
    expect(ctx.generations.get(id)?.status).toBe('FAILED');
    expect(ctx.generations.get(id)?.error).toBe('MALFORMED_OUTPUT');
    expect(ctx.debits).toHaveLength(0);
  });
});

describe('P0#2 — duplicate delivery and terminal states are skipped', () => {
  it('delivery while PROCESSING fresh -> skipped, LLM never called', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx, 'PROCESSING_LLM', new Date());
    const llm = stubLlm(['ok']);

    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 1,
      maxAttempts: 3,
    });

    expect(outcome).toBe('skipped');
    expect(llm.calls).toBe(0);
    expect(ctx.debits).toHaveLength(0);
  });

  it('stale PROCESSING (crashed worker) is reclaimed and processed', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx, 'PROCESSING_LLM', new Date(Date.now() - 3600_000));
    const llm = stubLlm(['ok']);

    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 1,
      maxAttempts: 3,
    });

    expect(outcome).toBe('completed');
    expect(llm.calls).toBe(1);
    expect(ctx.debits.filter((d) => d.reference === `generation:${id}`)).toHaveLength(1);
  });

  it('COMPLETED redelivery (lost ack) -> skipped, no second debit/slides/event', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const llm = stubLlm(['ok', 'ok']);

    expect(
      await processGeneration(ctx.db, llm as never, { generationId: id, attemptsMade: 0, maxAttempts: 3 }),
    ).toBe('completed');
    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: id,
      attemptsMade: 0,
      maxAttempts: 3,
    });

    expect(outcome).toBe('skipped');
    expect(llm.calls).toBe(1);
    expect(ctx.debits.filter((d) => d.reference === `generation:${id}`)).toHaveLength(1);
    expect(ctx.events.filter((e) => e.name === 'user_activated')).toHaveLength(1);
  });

  it('missing generation -> skipped without retry', async () => {
    const ctx = makeFakeDb();
    const llm = stubLlm(['ok']);
    const outcome = await processGeneration(ctx.db, llm as never, {
      generationId: 'does-not-exist',
      attemptsMade: 2,
      maxAttempts: 3,
    });
    expect(outcome).toBe('skipped');
    expect(llm.calls).toBe(0);
  });
});

describe('P0#2 — concurrency: two claimants, one owner', () => {
  it('exactly one of two concurrent atomic claims wins', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const fakeClaimDb = {
      generation: {
        updateMany: ctx.db.generation.updateMany,
        findUnique: ctx.db.generation.findUnique,
      },
    };
    const [a, b] = await Promise.all([
      claim.acquireForProcessing(fakeClaimDb as never, id),
      claim.acquireForProcessing(fakeClaimDb as never, id),
    ]);
    expect([a, b].filter((x) => x === 'claimed')).toHaveLength(1);
    expect([a, b].filter((x) => x === 'skip-busy')).toHaveLength(1);
  });

  it('second completion attempt is idempotent (unique violation -> no double debit)', async () => {
    const ctx = makeFakeDb();
    const id = seedGeneration(ctx);
    const llm = stubLlm(['ok', 'ok']);

    expect(
      await processGeneration(ctx.db, llm as never, { generationId: id, attemptsMade: 0, maxAttempts: 3 }),
    ).toBe('completed');
    // Accusé de réception perdu + réclamation d'une ligne obsolète : le second
    // claim réussit (PROCESSING_* vieux de 1 h), le LLM tourne à nouveau, mais
    // l'unicité du ledger (userId, type, reference) rejette le 2e débit.
    // Le test "COMPLETED redelivery" ci-dessus couvre le chemin skip-terminal.
    ctx.generations.get(id)!.status = 'PROCESSING_LLM';
    ctx.generations.get(id)!.startedAt = new Date(Date.now() - 3600_000);
    expect(
      await processGeneration(ctx.db, llm as never, { generationId: id, attemptsMade: 0, maxAttempts: 3 }),
    ).toBe('completed');
    expect(ctx.debits.filter((d) => d.reference === `generation:${id}`)).toHaveLength(1);
  });
});

describe('P0#2 — retry policy units', () => {
  it('shouldRetry respects remaining attempts', () => {
    expect(claim.shouldRetry(0, 3)).toBe(true);
    expect(claim.shouldRetry(1, 3)).toBe(true);
    expect(claim.shouldRetry(2, 3)).toBe(false);
    expect(claim.shouldRetry(0, 1)).toBe(false);
  });

  it('isTransientError classifies network/timeout vs semantic', () => {
    expect(claim.isTransientError(new Error('Simulated timeout'))).toBe(true);
    expect(claim.isTransientError(new Error('TIMEOUT'))).toBe(true);
    expect(claim.isTransientError(new Error('request failed with 503'))).toBe(true);
    expect(claim.isTransientError(new Error('Invalid JSON simulated'))).toBe(false);
    expect(claim.isTransientError(new Error('schema invalid: slides'))).toBe(false);
  });
});

describe('Concurrency residual R1 — check-then-act documentation', () => {
  it('two parallel hasInProgress-style checks can both pass (known race, DB guard pending)', async () => {
    // Mirrors GenerationService.hasInProgress/hasCredits read path: a bare count
    // with no lock. Both readers observe the pre-create state.
    let rows = 0;
    const checkThenCreate = async () => {
      const seen = rows; // read
      await new Promise((r) => setTimeout(r, 5)); // interleave window
      if (seen === 0) {
        rows += 1; // create
        return 'accepted';
      }
      return 'rejected';
    };
    const [a, b] = await Promise.all([checkThenCreate(), checkThenCreate()]);
    // Documents the residual race (R1): application-level checks alone cannot
    // serialize concurrent creates. A DB-level guard is still required.
    expect([a, b]).toEqual(['accepted', 'accepted']);
  });
});
