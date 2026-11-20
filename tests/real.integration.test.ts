/**
 * M007 exit gate — REAL infrastructure only.
 *
 * Ce fichier n'utilise AUCUN double Prisma / Redis : il démarre le vrai
 * AppModule Nest (serveur HTTP), le vrai client Prisma sur PostgreSQL 16,
 * un vrai Worker BullMQ sur Redis 7, et vérifie les invariants en base.
 *
 * Prérequis (fournis par .github/workflows/ci.yml) :
 *   DATABASE_URL=postgresql://test:test@127.0.0.1:5432/slideify_test
 *   REDIS_HOST=127.0.0.1 REDIS_PORT=6379 AUTH_SECRET=<32+ chars>
 *   `pnpm --filter @slideify/schema db:migrate:deploy` déjà exécuté.
 */
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Worker } from 'bullmq';
import { CreditTransactionType, GenerationStatus } from '@prisma/client';
import { config } from '@slideify/config';
import { prisma } from '@slideify/schema';
import { MockProvider } from '@slideify/llm';
import { AppModule } from '../apps/api/src/app.module';
import { HttpExceptionFilter } from '../apps/api/src/common/errors/http-exception.filter';
import { processGeneration } from '../apps/worker/src/processor';
import { reapStaleGenerations } from '../apps/worker/src/index';

const PREFIX = config.apiPrefix || '/api';
const SOURCE_TEXT = Array.from(
  { length: 140 },
  (_, i) => `mot${i}`,
).join(' '); // 140 mots : dans [80, 3000]
const ACTIVE: GenerationStatus[] = [
  GenerationStatus.QUEUED,
  GenerationStatus.PROCESSING_LLM,
  GenerationStatus.PROCESSING_RENDER,
];
const REDIS = {
  host: config.redis.host,
  port: config.redis.port,
  ...(config.redis.password ? { password: config.redis.password } : {}),
};

interface HttpResult {
  status: number;
  body: any;
}

async function call(
  baseUrl: string,
  method: 'GET' | 'POST',
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${PREFIX}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/** Vérifie qu'une requête brute a bien été rejetée par PostgreSQL (SQLSTATE). */
async function expectRawSqlFailure(
  query: Promise<unknown>,
  sqlState: string,
): Promise<void> {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  expect((caught as { code?: string }).code).toBe('P2010');
  expect(JSON.stringify(caught)).toContain(`"code":"${sqlState}"`);
}

async function cleanDatabase(): Promise<void> {
  // Ordre conforme aux clés étrangères (tout est en cascade, mais explicite).
  await prisma.generationEvent.deleteMany();
  await prisma.output.deleteMany();
  await prisma.slide.deleteMany();
  await prisma.generation.deleteMany();
  await prisma.creditTransaction.deleteMany();
  await prisma.webhookEvent.deleteMany();
  await prisma.user.deleteMany();
}

async function registerUser(app: INestApplication, baseUrl: string) {
  const email = `m007-${randomUUID()}@example.com`;
  const password = 'Password123!';
  const registered = await call(baseUrl, 'POST', '/auth/register', {
    body: { email, password },
  });
  expect(registered.status).toBe(201);
  const loggedIn = await call(baseUrl, 'POST', '/auth/login', {
    body: { email, password },
  });
  expect(loggedIn.status).toBe(200);
  expect(typeof loggedIn.body.accessToken).toBe('string');
  return {
    email,
    userId: registered.body.userId as string,
    token: loggedIn.body.accessToken as string,
  };
}

async function waitForTerminal(
  generationId: string,
  timeoutMs = 30_000,
): Promise<{ status: GenerationStatus; error: string | null }> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.generation.findUnique({ where: { id: generationId } });
    if (row && !ACTIVE.includes(row.status)) {
      return { status: row.status, error: row.error };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Generation ${generationId} never reached a terminal state`);
}

function startTestWorker(seenPayloads: unknown[] = []): Worker {
  return new Worker(
    'generation',
    async (job) => {
      seenPayloads.push(job.data);
      return processGeneration(prisma, new MockProvider(), {
        generationId: (job.data as { generationId: string }).generationId,
        attemptsMade: job.attemptsMade,
        maxAttempts: typeof job.opts.attempts === 'number' ? job.opts.attempts : 3,
      });
    },
    { connection: REDIS, concurrency: 1 }, // UN seul consommateur (invariant M006)
  );
}

describe('M007 — intégration réelle PostgreSQL 16 + Redis 7 + Nest HTTP', () => {
  let app: INestApplication;
  let baseUrl: string;
  let queue: Queue;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix(PREFIX);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.listen(0);
    baseUrl = await app.getUrl();

    queue = new Queue('generation', { connection: REDIS });
    await cleanDatabase();
  });

  beforeEach(async () => {
    await cleanDatabase();
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    if (queue) await queue.obliterate({ force: true }).catch(() => undefined);
    if (queue) await queue.close().catch(() => undefined);
    if (app) await app.close();
    await prisma.$disconnect();
  });

  it('boot: health + 3 crédits atomiques à l’inscription', async () => {
    const health = await call(baseUrl, 'GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body.status).toBe('ok');

    const user = await registerUser(app, baseUrl);
    const grants = await prisma.creditTransaction.findMany({
      where: { userId: user.userId },
    });
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(3);
    expect(grants[0].type).toBe(CreditTransactionType.MANUAL_GRANT);
    expect(grants[0].reference).toBe('signup_bonus');

    const me = await call(baseUrl, 'GET', '/auth/me', { token: user.token });
    expect(me.status).toBe(200);
    expect(me.body).toEqual({
      userId: user.userId,
      email: user.email,
      credits: 3,
    });
  });

  it('flux HTTP complet : register → login → POST → BullMQ → COMPLETED → 1 seul débit', async () => {
    const user = await registerUser(app, baseUrl);

    const created = await call(baseUrl, 'POST', '/generations', {
      token: user.token,
      body: { sourceText: SOURCE_TEXT },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({
      status: GenerationStatus.QUEUED,
      generationId: expect.any(String),
    });
    const id = created.body.generationId as string;

    const payloads: unknown[] = [];
    const worker = startTestWorker(payloads);
    let terminal: { status: GenerationStatus; error: string | null };
    try {
      terminal = await waitForTerminal(id);
    } finally {
      await worker.close();
    }
    expect(terminal.error).toBeNull();
    expect(terminal.status).toBe(GenerationStatus.COMPLETED);

    // Contrat M004 : { generationId } uniquement dans le payload BullMQ.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({ generationId: id });
    expect(payloads[0]).not.toHaveProperty('sourceText');
    expect(payloads[0]).not.toHaveProperty('userId');

    const generation = await prisma.generation.findUnique({ where: { id } });
    expect(generation?.slideCount).toBeGreaterThanOrEqual(5);
    expect(generation?.slideCount).toBeLessThanOrEqual(10);

    const slides = await prisma.slide.findMany({
      where: { generationId: id },
      orderBy: { order: 'asc' },
    });
    expect(slides).toHaveLength(generation!.slideCount!);
    expect(slides.map((s) => s.order)).toEqual(
      slides.map((_, index) => index + 1),
    );
    expect(slides.every((s) => s.title.length <= 60 && s.body.length <= 220)).toBe(true);

    const debits = await prisma.creditTransaction.findMany({
      where: {
        type: CreditTransactionType.GENERATION_DEBIT,
        reference: `generation:${id}`,
      },
    });
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(-1);

    const balance = await prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: user.userId },
    });
    expect(balance._sum.amount).toBe(2);

    const activations = await prisma.generationEvent.findMany({
      where: { actorId: user.userId, name: 'user_activated' },
    });
    expect(activations).toHaveLength(1);

    // E-18 / D-02 : sourceText absent de l'historique ET du statut COMPLETED.
    const history = await call(baseUrl, 'GET', '/generations', {
      token: user.token,
    });
    expect(history.status).toBe(200);
    expect(history.body).toHaveLength(1);
    expect(history.body[0]).not.toHaveProperty('sourceText');

    const status = await call(baseUrl, 'GET', `/generations/${id}/status`, {
      token: user.token,
    });
    expect(status.status).toBe(200);
    expect(status.body.status).toBe(GenerationStatus.COMPLETED);
    expect(status.body).not.toHaveProperty('sourceText');

    // Contrats d'erreur réels : 401 et 404 (pas de 403, pas de fuite inter-user).
    const anonymous = await call(baseUrl, 'GET', `/generations/${id}/status`);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.code).toBe('UNAUTHENTICATED');

    const stranger = await registerUser(app, baseUrl);
    const notFound = await call(baseUrl, 'GET', `/generations/${id}/status`, {
      token: stranger.token,
    });
    expect(notFound.status).toBe(404);
    expect(notFound.body.code).toBe('NOT_FOUND');
  });

  it('invariant 1 : concurrence HTTP → exactement 1 actif, 409 + activeGenerationId', async () => {
    const user = await registerUser(app, baseUrl);
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(baseUrl, 'POST', '/generations', {
          token: user.token,
          body: { sourceText: SOURCE_TEXT },
        }),
      ),
    );

    const accepted = attempts.filter((r) => r.status === 201);
    const conflicts = attempts.filter((r) => r.status === 409);
    expect(accepted).toHaveLength(1);
    expect(conflicts).toHaveLength(7);
    expect(conflicts.every((r) => r.body.code === 'GENERATION_IN_PROGRESS')).toBe(
      true,
    );
    const activeId = accepted[0].body.generationId as string;
    expect(conflicts.every((r) => r.body.activeGenerationId === activeId)).toBe(
      true,
    );

    const activeRows = await prisma.generation.count({
      where: { userId: user.userId, status: { in: ACTIVE } },
    });
    expect(activeRows).toBe(1);

    // Garde finale en base : Prisma contourne le verrou applicatif, pas l'index.
    await expect(
      prisma.generation.create({
        data: { userId: user.userId, sourceText: SOURCE_TEXT, status: GenerationStatus.QUEUED },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    // Un état terminal libère l'index partiel.
    await prisma.generation.update({
      where: { id: activeId },
      data: { status: GenerationStatus.FAILED, error: 'MANUAL_RESET' },
    });
    const retry = await call(baseUrl, 'POST', '/generations', {
      token: user.token,
      body: { sourceText: SOURCE_TEXT },
    });
    expect(retry.status).toBe(201);
  });

  it('invariant 2 : rejeu de complétion → 1 seul débit, 1 seul user_activated', async () => {
    const user = await registerUser(app, baseUrl);
    const created = await call(baseUrl, 'POST', '/generations', {
      token: user.token,
      body: { sourceText: SOURCE_TEXT },
    });
    expect(created.status).toBe(201);
    const id = created.body.generationId as string;

    const worker = startTestWorker();
    try {
      expect((await waitForTerminal(id)).status).toBe(GenerationStatus.COMPLETED);
    } finally {
      await worker.close();
    }

    // Accusé de réception perdu + ligne réclamée comme obsolète : le second
    // passage atteint la transaction de complétion mais heurte l'unicité du
    // ledger (vraie contrainte PostgreSQL P2002).
    await prisma.generation.update({
      where: { id },
      data: {
        status: GenerationStatus.PROCESSING_LLM,
        startedAt: new Date(Date.now() - 3_600_000),
      },
    });
    await expect(
      processGeneration(prisma, new MockProvider(), {
        generationId: id,
        attemptsMade: 0,
        maxAttempts: 3,
      }),
    ).resolves.toBe('completed');

    const debits = await prisma.creditTransaction.count({
      where: {
        type: CreditTransactionType.GENERATION_DEBIT,
        reference: `generation:${id}`,
      },
    });
    expect(debits).toBe(1);
    const activations = await prisma.generationEvent.count({
      where: { actorId: user.userId, name: 'user_activated' },
    });
    expect(activations).toBe(1);
    const final = await prisma.generation.findUnique({ where: { id } });
    expect(final?.status).toBe(GenerationStatus.COMPLETED);
    const balance = await prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: user.userId },
    });
    expect(balance._sum.amount).toBe(2);
  });

  it('invariant 4 : 3 crédits → 3 générations → 402 NO_CREDITS, solde jamais négatif', async () => {
    const user = await registerUser(app, baseUrl);
    for (let i = 0; i < 3; i += 1) {
      const created = await call(baseUrl, 'POST', '/generations', {
        token: user.token,
        body: { sourceText: SOURCE_TEXT },
      });
      expect(created.status).toBe(201);
      const worker = startTestWorker();
      try {
        expect((await waitForTerminal(created.body.generationId)).status).toBe(
          GenerationStatus.COMPLETED,
        );
      } finally {
        await worker.close();
      }
    }

    const fourth = await call(baseUrl, 'POST', '/generations', {
      token: user.token,
      body: { sourceText: SOURCE_TEXT },
    });
    expect(fourth.status).toBe(402);
    expect(fourth.body.code).toBe('NO_CREDITS');

    const balance = await prisma.creditTransaction.aggregate({
      _sum: { amount: true },
      where: { userId: user.userId },
    });
    expect(balance._sum.amount).toBe(0);
    const negative = await prisma.creditTransaction.count({
      where: { userId: user.userId, amount: { lt: 0 } },
    });
    expect(negative).toBe(3); // un débit par génération, pas plus
  });

  it('plafond absolu : le reaper échoue un QUEUED âgé de > 5 min en FAILED/TIMEOUT', async () => {
    const user = await registerUser(app, baseUrl);
    const stale = await prisma.generation.create({
      data: {
        userId: user.userId,
        sourceText: SOURCE_TEXT,
        status: GenerationStatus.QUEUED,
        createdAt: new Date(Date.now() - 6 * 60 * 1000),
      },
    });

    await expect(reapStaleGenerations(prisma)).resolves.toBeGreaterThanOrEqual(1);
    const failed = await prisma.generation.findUnique({ where: { id: stale.id } });
    expect(failed?.status).toBe(GenerationStatus.FAILED);
    expect(failed?.error).toBe('TIMEOUT');

    // D-02 : sourceText n'est renvoyé qu'au propriétaire d'un FAILED.
    const status = await call(baseUrl, 'GET', `/generations/${stale.id}/status`, {
      token: user.token,
    });
    expect(status.status).toBe(200);
    expect(status.body.sourceText).toBe(SOURCE_TEXT);

    const retry = await call(baseUrl, 'POST', '/generations', {
      token: user.token,
      body: { sourceText: SOURCE_TEXT },
    });
    expect(retry.status).toBe(201);
  });

  it('Redis indisponible → HTTP 503 QUEUE_UNAVAILABLE et ligne terminale (pas de blocage)', async () => {
    const user = await registerUser(app, baseUrl);
    const deadQueue = new Queue('generation', {
      connection: {
        host: '127.0.0.1',
        port: 1, // port non écouté : vrai client Redis, vraie panne réseau
        retryStrategy: () => null,
      },
    });

    const brokenModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(getQueueToken('generation'))
      .useValue(deadQueue)
      .compile();
    const brokenApp = brokenModule.createNestApplication();
    brokenApp.setGlobalPrefix(PREFIX);
    brokenApp.useGlobalFilters(new HttpExceptionFilter());
    await brokenApp.listen(0);

    try {
      const result = await call(await brokenApp.getUrl(), 'POST', '/generations', {
        token: user.token,
        body: { sourceText: SOURCE_TEXT },
      });
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('QUEUE_UNAVAILABLE');

      const rows = await prisma.generation.findMany({
        where: { userId: user.userId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe(GenerationStatus.FAILED);
      expect(rows[0].error).toBe('QUEUE_UNAVAILABLE');
      expect(await prisma.creditTransaction.count({
        where: { type: CreditTransactionType.GENERATION_DEBIT, userId: user.userId },
      })).toBe(0);

      // L'index partiel est libéré : l'utilisateur peut réessayer plus tard.
      const later = await call(baseUrl, 'POST', '/generations', {
        token: user.token,
        body: { sourceText: SOURCE_TEXT },
      });
      expect(later.status).toBe(201);
    } finally {
      await brokenApp.close();
      await deadQueue.close().catch(() => undefined);
    }
  });

  it('contraintes SQL du ledger et index partiel (preuve base, sans application)', async () => {
    const user = await registerUser(app, baseUrl);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CreditTransaction" ("id","userId","amount","type","reference","createdAt")
         VALUES ('bad_amount','${user.userId}',-2,'GENERATION_DEBIT','generation:bad_amount',NOW())`,
      ),
    ).rejects.toThrow(/Credit_debit_amount_check/);

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CreditTransaction" ("id","userId","amount","type","reference","createdAt")
         VALUES ('bad_reference','${user.userId}',-1,'GENERATION_DEBIT','',NOW())`,
      ),
    ).rejects.toThrow(/Credit_debit_reference_check/);

    await prisma.$executeRawUnsafe(
      `INSERT INTO "CreditTransaction" ("id","userId","amount","type","reference","createdAt")
       VALUES ('dup_1','${user.userId}',-1,'GENERATION_DEBIT','generation:dup',NOW())`,
    );
    // Prisma n'inclut pas le nom de la contrainte dans le message d'une
    // violation 23505 : on vérifie le SQLSTATE natif renvoyé par PostgreSQL.
    await expectRawSqlFailure(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CreditTransaction" ("id","userId","amount","type","reference","createdAt")
         VALUES ('dup_2','${user.userId}',-1,'GENERATION_DEBIT','generation:dup',NOW())`,
      ),
      '23505',
    );

    const insertActive = (id: string) =>
      prisma.$executeRawUnsafe(
        `INSERT INTO "Generation" ("id","userId","sourceText","status","createdAt","updatedAt")
         VALUES ('${id}','${user.userId}','texte','QUEUED',NOW(),NOW())`,
      );
    await insertActive('active_1');
    await expectRawSqlFailure(insertActive('active_2'), '23505');
  });
});
