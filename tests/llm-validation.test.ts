// Env avant les imports de @slideify/llm / @slideify/config.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/slideify_test';
process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'unit-test-secret-0123456789abcdef';
process.env.AI_PROVIDER = 'mock';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { processGeneration } = require('../apps/worker/src/processor');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { InvalidJSONResponseError } = require('../packages/llm/src/providers');

type SlideOut = { order: number; title: string; body: string; html?: unknown };

function makeDb() {
  const generations = new Map<string, { id: string; userId: string; sourceText: string; status: string; startedAt: Date | null; slideCount: number | null; error: string | null; completedAt: Date | null }>();
  const slides = new Map<string, SlideOut[]>();
  const debits: unknown[] = [];
  const events: unknown[] = [];

  const generation = {
    findUnique: async ({ where }: { where: { id: string } }) => generations.get(where.id) ?? null,
    findFirst: async () => null,
    updateMany: async ({ where, data }: { where: { id: string; status?: unknown }; data: Record<string, unknown> }) => {
      const g = generations.get(where.id);
      if (!g) return { count: 0 };
      if (typeof where.status === 'string' && g.status !== where.status) return { count: 0 };
      if (where.status && typeof where.status === 'object' && !(where.status as { in: string[] }).in.includes(g.status)) return { count: 0 };
      Object.assign(g, data);
      return { count: 1 };
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const g = generations.get(where.id);
      if (!g) throw new Error('not found');
      Object.assign(g, data);
      return g;
    },
  };
  const creditTransaction = {
    create: async ({ data }: { data: unknown }) => {
      debits.push(data);
      return data;
    },
    aggregate: async () => ({ _sum: { amount: 3 - debits.length } }),
  };
  const slide = {
    deleteMany: async () => ({ count: 0 }),
    createMany: async ({ data }: { data: SlideOut[] }) => {
      const list = data.map((s) => ({ order: s.order, title: s.title, body: s.body }));
      slides.set(list[0] ? 'gen_1' : '', list);
      return { count: list.length };
    },
  };
  const generationEvent = {
    create: async ({ data }: { data: unknown }) => (events.push(data), data),
    createMany: async ({ data }: { data: unknown[] }) => (events.push(...data), { count: data.length }),
  };
  const api = {
    generation,
    creditTransaction,
    slide,
    generationEvent,
    $queryRawUnsafe: async () => [],
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  const id = 'gen_1';
  generations.set(id, {
    id,
    userId: 'user_1',
    sourceText: 'word '.repeat(120).trim(),
    status: 'QUEUED',
    startedAt: null,
    slideCount: null,
    error: null,
    completedAt: null,
  });
  return { db: api, id, generations, slides, debits, events };
}

function slides(n: number, overrides: Record<string, unknown> = {}) {
  return Array.from({ length: n }, (_, i) => ({
    order: i + 1,
    title: `Title ${i + 1}`,
    body: `Body ${i + 1} with enough content.`,
    ...overrides,
  }));
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    slides: slides(5),
    meta: { slide_count: 5, source_language: 'fr' },
    ...overrides,
  };
}

function llmReturning(value: unknown, calls = { n: 0 }) {
  return {
    async generate() {
      calls.n += 1;
      if (value instanceof Error) throw value;
      return value;
    },
    get calls() {
      return calls.n;
    },
  };
}

async function run(payload: unknown) {
  const ctx = makeDb();
  const llm = llmReturning(payload);
  const outcome = await processGeneration(ctx.db, llm, {
    generationId: ctx.id,
    attemptsMade: 0,
    maxAttempts: 3,
  });
  return { ...ctx, outcome, llmCalls: llm.calls };
}

describe('M006 §4.2 — matrice de validation de la réponse IA', () => {
  it('titre 61 / corps 235 → COMPLETED, tronqué au mot entier', async () => {
    const r = await run(response({
      slides: [
        { order: 1, title: 'a'.repeat(70), body: 'b'.repeat(235) },
        ...slides(4),
      ],
    }));
    expect(r.outcome).toBe('completed');
    const first = r.slides.get('gen_1')![0];
    expect(first.title.length).toBeLessThanOrEqual(60);
    expect(first.body.length).toBeLessThanOrEqual(220);
    expect(first.title.endsWith('…')).toBe(true);
  });

  it('titre 400 / corps 1500 → FAILED/MALFORMED_OUTPUT', async () => {
    const r = await run(response({
      slides: [{ order: 1, title: 'a'.repeat(400), body: 'b'.repeat(1500) }, ...slides(4)],
    }));
    expect(r.outcome).toBe('failed');
    expect(r.generations.get('gen_1')!.error).toBe('MALFORMED_OUTPUT');
    expect(r.debits).toHaveLength(0);
  });

  it.each([
    ['absent', { order: 1, body: 'ok' }],
    ['null', { order: 1, title: null, body: 'ok' }],
    ['numérique', { order: 1, title: 123, body: 'ok' }],
    ['vide', { order: 1, title: '', body: 'ok' }],
    ['espaces', { order: 1, title: '   ', body: 'ok' }],
  ])('title %s → MALFORMED_OUTPUT', async (_label, badSlide) => {
    const r = await run(response({ slides: [badSlide, ...slides(4)] }));
    expect(r.outcome).toBe('failed');
    expect(r.generations.get('gen_1')!.error).toBe('MALFORMED_OUTPUT');
  });

  it.each([4, 11])('%i slides → MALFORMED_OUTPUT', async (n) => {
    const r = await run(response({ slides: slides(n) }));
    expect(r.outcome).toBe('failed');
    expect(r.generations.get('gen_1')!.error).toBe('MALFORMED_OUTPUT');
  });

  it('slides absent ou vide → MALFORMED_OUTPUT', async () => {
    expect((await run({ meta: { slide_count: 0, source_language: 'fr' } })).outcome).toBe('failed');
    expect((await run(response({ slides: [] }))).outcome).toBe('failed');
  });

  it('order "1" → MALFORMED_OUTPUT', async () => {
    const r = await run(response({ slides: [{ order: '1', title: 't', body: 'b' }, ...slides(4)] }));
    expect(r.outcome).toBe('failed');
    expect(r.generations.get('gen_1')!.error).toBe('MALFORMED_OUTPUT');
  });

  it('orders dupliqués / non contigus → COMPLETED et renumérotés 1..N', async () => {
    const raw = [3, 1, 1, 7, 5].map((order, i) => ({
      order,
      title: `Title ${i}`,
      body: `Body ${i} with content.`,
    }));
    const r = await run(response({ slides: raw }));
    expect(r.outcome).toBe('completed');
    expect(r.slides.get('gen_1')!.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);
  });

  it.each(['fr-FR', 'French', ''])('source_language %p ne bloque jamais', async (value) => {
    const r = await run(response({ meta: { slide_count: 5, source_language: value } }));
    expect(r.outcome).toBe('completed');
  });

  it('source_language non-chaîne → MALFORMED_OUTPUT', async () => {
    const r = await run(response({ meta: { slide_count: 5, source_language: 42 } }));
    expect(r.outcome).toBe('failed');
    expect(r.generations.get('gen_1')!.error).toBe('MALFORMED_OUTPUT');
  });

  it('champ inconnu html retiré avant persistance', async () => {
    const r = await run(response({ slides: [{ order: 1, title: 't', body: 'b', html: '<b>x</b>' }, ...slides(4)] }));
    expect(r.outcome).toBe('completed');
    expect(r.slides.get('gen_1')![0]).not.toHaveProperty('html');
  });

  it('JSON non parsable → exactement un retry puis INVALID_RESPONSE', async () => {
    const ctx = makeDb();
    const llm = {
      calls: 0,
      async generate() {
        this.calls += 1;
        throw new InvalidJSONResponseError('bad json');
      },
    };
    const outcome = await processGeneration(ctx.db, llm, {
      generationId: ctx.id,
      attemptsMade: 0,
      maxAttempts: 3,
    });
    expect(outcome).toBe('failed');
    expect(llm.calls).toBe(2);
    expect(ctx.generations.get(ctx.id)!.error).toBe('INVALID_RESPONSE');
    expect(ctx.debits).toHaveLength(0);
  });
});
