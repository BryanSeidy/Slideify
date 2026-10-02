import { prisma } from '../packages/schema/src/prisma';

describe('Database schema', () => {
  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://slideify:slideify_password@localhost:5432/slideify';
  });

  it('prisma client can be instantiated', async () => {
    expect(prisma).toBeDefined();
  });

  it('schema has all required models', () => {
    expect(prisma.user).toBeDefined();
    expect(prisma.creditTransaction).toBeDefined();
    expect(prisma.generation).toBeDefined();
    expect(prisma.slide).toBeDefined();
    expect(prisma.output).toBeDefined();
    expect(prisma.generationEvent).toBeDefined();
    expect(prisma.webhookEvent).toBeDefined();
  });
});
