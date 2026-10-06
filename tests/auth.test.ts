import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';

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
  const users = new Map<string, { id: string; email: string; passwordHash: string }>();
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
      create: async ({ data }: { data: { email: string; passwordHash: string } }) => {
        for (const u of users.values()) {
          if (u.email === data.email) {
            const err = new Error('Unique constraint failed on User(email)') as Error & { code: string };
            err.code = 'P2002';
            throw err;
          }
        }
        const u = { id: `user_${seq++}`, email: data.email, passwordHash: data.passwordHash };
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

function makeController() {
  const fake = makeFakePrisma();
  const service = new AuthService(fake, new JwtService({ secret: TEST_SECRET }));
  const controller = new AuthController(service);
  return { fake, controller };
}

describe('P0 M004.3 — AuthModule wiring', () => {
  it('AuthModule compiles and exposes AuthController', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(PrismaService)
      .useValue(makeFakePrisma())
      .compile();
    const controller = moduleRef.get(AuthController, { strict: false });
    expect(controller).toBeDefined();
    await moduleRef.close();
  });

  it('AuthController declares POST auth/register, POST auth/login, GET auth/me (no magic-link)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(PrismaService)
      .useValue(makeFakePrisma())
      .compile();
    const controller = moduleRef.get(AuthController, { strict: false });
    expect(typeof controller.register).toBe('function');
    expect(typeof controller.login).toBe('function');
    expect(typeof controller.getMe).toBe('function');
    expect(controller.sendMagicLink).toBeUndefined();
    await moduleRef.close();
  });
});

describe('P0 M004.3 — register creates credential-protected accounts', () => {
  it('valid register stores a salted hash (never plaintext) and grants +3 once', async () => {
    const { fake, controller } = makeController();
    const res = await controller.register('new@example.com', 'correct-horse-123');

    expect(res.email).toBe('new@example.com');
    expect(res.credits).toBe(3);
    expect((res as Record<string, unknown>).accessToken).toBeUndefined();
    expect((res as Record<string, unknown>).passwordHash).toBeUndefined();

    const stored = fake.users.get(res.userId);
    expect(stored).toBeDefined();
    expect(stored!.passwordHash).not.toBe('correct-horse-123');
    expect(await bcrypt.compare('correct-horse-123', stored!.passwordHash)).toBe(true);
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]).toMatchObject({ amount: 3, type: 'MANUAL_GRANT', reference: 'signup_bonus' });
  });

  it('same password yields different hashes (per-user salt)', async () => {
    const { fake, controller } = makeController();
    const a = await controller.register('a@example.com', 'shared-secret-1');
    const b = await controller.register('b@example.com', 'shared-secret-1');
    expect(fake.users.get(a.userId)!.passwordHash).not.toBe(fake.users.get(b.userId)!.passwordHash);
  });

  it('duplicate email is rejected (409) with no second grant', async () => {
    const { fake, controller } = makeController();
    await controller.register('dup@example.com', 'password-one');
    await expect(controller.register('dup@example.com', 'password-two')).rejects.toMatchObject({ status: 409 });
    expect(fake.ledger.filter((l) => l.type === 'MANUAL_GRANT')).toHaveLength(1);
  });

  it('invalid email / short password are rejected (400) with no account created', async () => {
    const { fake, controller } = makeController();
    await expect(controller.register('not-an-email', 'valid-password-1')).rejects.toMatchObject({ status: 400 });
    await expect(controller.register('ok@example.com', 'short')).rejects.toMatchObject({ status: 400 });
    await expect(controller.register('', '')).rejects.toMatchObject({ status: 400 });
    expect(fake.users.size).toBe(0);
    expect(fake.ledger).toHaveLength(0);
  });
});

describe('P0 M004.3 — email alone never yields a JWT', () => {
  it('login with correct password returns a verifiable JWT', async () => {
    const { controller } = makeController();
    await controller.register('user@example.com', 'my-password-9');
    const login = await controller.login('user@example.com', 'my-password-9');

    expect(typeof login.accessToken).toBe('string');
    const payload = new JwtService({ secret: TEST_SECRET }).verify(login.accessToken) as {
      sub: string;
      email: string;
    };
    expect(payload.sub).toBe(login.userId);
    expect(payload.email).toBe('user@example.com');
  });

  it("an attacker with only the victim's email gets 401 (no JWT)", async () => {
    const { controller } = makeController();
    await controller.register('victim@example.com', 'victim-secret-7');
    await expect(controller.login('victim@example.com', 'attacker-guess-1')).rejects.toMatchObject({
      status: 401,
    });
  });

  it('unknown email and wrong password fail IDENTICALLY (no enumeration)', async () => {
    const { controller } = makeController();
    await controller.register('real@example.com', 'real-password-5');

    const unknownErr = await controller.login('ghost@example.com', 'whatever-pass').catch((e: unknown) => e) as {
      status: number;
      getResponse(): unknown;
    };
    const wrongErr = await controller.login('real@example.com', 'wrong-password').catch((e: unknown) => e) as {
      status: number;
      getResponse(): unknown;
    };

    expect(unknownErr.status).toBe(401);
    expect(wrongErr.status).toBe(401);
    expect(unknownErr.getResponse()).toEqual(wrongErr.getResponse());
    expect(unknownErr.getResponse()).toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('login with malformed input is rejected (400), never 401/500', async () => {
    const { controller } = makeController();
    await expect(controller.login('not-an-email', 'valid-password-1')).rejects.toMatchObject({ status: 400 });
    await expect(controller.login('user@example.com', 'short')).rejects.toMatchObject({ status: 400 });
  });
});

describe('P0 M004.3 — protected routes use JWT identity only', () => {
  it('getMe returns the JWT identity (no body userId exists)', async () => {
    const { controller } = makeController();
    const me = await controller.getMe({ user: { userId: 'u1', email: 'a@b.c', credits: 2 } });
    expect(me).toEqual({ userId: 'u1', email: 'a@b.c', credits: 2 });
  });

  it('JwtAuthGuard accepts a valid token and rejects missing/malformed/forged ones', () => {
    const guard = new JwtAuthGuard(new JwtService({ secret: TEST_SECRET }));
    const valid = new JwtService({ secret: TEST_SECRET }).sign({ sub: 'u1', email: 'a@b.c', credits: 1 });
    const forged = new JwtService({ secret: 'wrong-secret' }).sign({ sub: 'u1' });

    const okCtx = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: { authorization: `Bearer ${valid}` } as unknown, user: undefined as unknown }),
      }),
    };
    expect(guard.canActivate(okCtx as unknown as never)).toBe(true);

    for (const authorization of [undefined, 'Token abc', 'Bearer garbage', `Bearer ${forged}`]) {
      const ctx = {
        switchToHttp: () => ({
          getRequest: () => ({ headers: { authorization } as unknown, user: undefined as unknown }),
        }),
      };
      expect(guard.canActivate(ctx as unknown as never)).toBe(false);
    }
  });
});
