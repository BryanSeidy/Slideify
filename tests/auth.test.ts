import 'reflect-metadata';

// Env BEFORE requiring API modules: packages/config parses env at import time.
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/slideify_test';
process.env.AUTH_SECRET = 'unit-test-secret-0123456789abcdef';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Test } = require('@nestjs/testing');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JwtService } = require('@nestjs/jwt');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthModule } = require('../apps/api/src/auth/auth.module');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthController } = require('../apps/api/src/auth/auth.controller');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AuthService } = require('../apps/api/src/auth/auth.service');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { JwtAuthGuard } = require('../apps/api/src/auth/jwt.guard');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { PrismaService } = require('../apps/api/src/prisma/prisma.service');

const TEST_SECRET = 'unit-test-secret-0123456789abcdef';

function makeFakePrisma() {
  const users = new Map<string, { id: string; email: string }>();
  const ledger: Array<{ userId: string; amount: number; type: string; reference?: string }> = [];
  let seq = 1;
  const api = {
    users,
    ledger,
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) => {
        for (const u of users.values()) {
          if (where.email && u.email === where.email) return u;
          if (where.id && u.id === where.id) return u;
        }
        return null;
      },
      create: async ({ data }: { data: { email: string } }) => {
        const u = { id: `user_${seq++}`, email: data.email };
        users.set(u.id, u);
        return u;
      },
    },
    creditTransaction: {
      aggregate: async ({ where }: { where: { userId: string } }) => ({
        _sum: { amount: ledger.filter((l) => l.userId === where.userId).reduce((a, l) => a + l.amount, 0) },
      }),
      create: async ({ data }: { data: { userId: string; amount: number; type: string; reference?: string } }) => {
        ledger.push(data);
        return data;
      },
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(api),
  };
  return api;
}

describe('P0#1 — AuthModule wiring (M004.2)', () => {
  it('AuthModule compiles and exposes AuthController', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(PrismaService)
      .useValue(makeFakePrisma())
      .compile();
    const controller = moduleRef.get(AuthController, { strict: false });
    expect(controller).toBeDefined();
    await moduleRef.close();
  });

  it('AuthController declares POST auth/magic-link, POST auth/login, GET auth/me', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(PrismaService)
      .useValue(makeFakePrisma())
      .compile();
    const controller = moduleRef.get(AuthController, { strict: false });
    expect(typeof controller.sendMagicLink).toBe('function');
    expect(typeof controller.login).toBe('function');
    expect(typeof controller.getMe).toBe('function');
    await moduleRef.close();
  });
});

describe('P0#1 — register/login -> JWT -> protected route', () => {
  it('new email gets +3 MANUAL_GRANT and a verifiable JWT', async () => {
    const fake = makeFakePrisma();
    const service = new AuthService(fake, new JwtService({ secret: TEST_SECRET }));
    const controller = new AuthController(service);

    const login = await controller.login('new@example.com');
    expect(typeof login.accessToken).toBe('string');

    const payload = new JwtService({ secret: TEST_SECRET }).verify(login.accessToken) as {
      sub: string;
      email: string;
    };
    expect(payload.email).toBe('new@example.com');
    expect(payload.sub).toBe(login.userId);
    expect(login.credits).toBe(3);
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]).toMatchObject({ amount: 3, type: 'MANUAL_GRANT', reference: 'signup_bonus' });
  });

  it('existing user login reuses the account (no second grant)', async () => {
    const fake = makeFakePrisma();
    const service = new AuthService(fake, new JwtService({ secret: TEST_SECRET }));
    const controller = new AuthController(service);

    const first = await controller.login('same@example.com');
    const second = await controller.login('same@example.com');
    expect(second.userId).toBe(first.userId);
    expect(fake.ledger.filter((l) => l.type === 'MANUAL_GRANT')).toHaveLength(1);
    const payload = new JwtService({ secret: TEST_SECRET }).verify(second.accessToken) as { sub: string };
    expect(payload.sub).toBe(first.userId);
  });

  it('invalid email is rejected with 400 (never reaches the DB)', async () => {
    const fake = makeFakePrisma();
    const service = new AuthService(fake, new JwtService({ secret: TEST_SECRET }));
    const controller = new AuthController(service);
    await expect(controller.login('not-an-email')).rejects.toMatchObject({ status: 400 });
    await expect(controller.login('')).rejects.toMatchObject({ status: 400 });
    expect(fake.users.size).toBe(0);
  });

  it('getMe returns the JWT identity (never a body userId)', async () => {
    const fake = makeFakePrisma();
    const service = new AuthService(fake, new JwtService({ secret: TEST_SECRET }));
    const controller = new AuthController(service);
    const me = await controller.getMe({ user: { userId: 'u1', email: 'a@b.c', credits: 2 } });
    expect(me).toEqual({ userId: 'u1', email: 'a@b.c', credits: 2 });
  });
});

describe('P0#1 — JwtAuthGuard behavior', () => {
  const validToken = new JwtService({ secret: TEST_SECRET }).sign({ sub: 'u1', email: 'a@b.c', credits: 1 });

  function ctxWith(headers: Record<string, string | undefined>) {
    const req: { headers: unknown; user?: unknown } = { headers };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      req,
    };
  }

  it('accepts a valid Bearer token and sets req.user', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: TEST_SECRET }));
    const ctx = ctxWith({ authorization: `Bearer ${validToken}` });
    expect(guard.canActivate(ctx as unknown as never)).toBe(true);
    expect(ctx.req.user).toMatchObject({ userId: 'u1', email: 'a@b.c' });
  });

  it('rejects missing / malformed / forged tokens', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: TEST_SECRET }));
    const forged = new JwtService({ secret: 'wrong-secret' }).sign({ sub: 'u1' });
    for (const headers of [{}, { authorization: 'Token abc' }, { authorization: 'Bearer garbage' }, { authorization: `Bearer ${forged}` }]) {
      const ctx = ctxWith(headers);
      expect(guard.canActivate(ctx as unknown as never)).toBe(false);
      expect(ctx.req.user).toBeUndefined();
    }
  });
});
