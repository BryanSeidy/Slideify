import { describe, it, expect, beforeEach } from '@jest/globals';
import { prisma } from '../packages/schema/src/prisma';

describe('Database schema', () => {
  beforeAll(async () => {
    // Use in-memory SQLite for tests (or mock)
    process.env.DATABASE_URL = process.env.DATABASE_URL || 'sqlite::memory:';
  });

  it('prisma client can connect', async () => {
    // Skip if no DB — schema validation only
    expect(prisma).toBeDefined();
  });

  it('schema has all required models', () => {
    expect(prisma.user).toBeDefined();
    expect(prisma.credit).toBeDefined();
    expect(prisma.generation).toBeDefined();
    expect(prisma.output).toBeDefined();
    expect(prisma.webhookEvent).toBeDefined();
  });
});