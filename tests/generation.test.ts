import { describe, it, expect, beforeEach } from '@jest/globals';
import { GenerationQueueService } from '../apps/api/src/generation/generation.service';
import { PrismaService } from '../apps/api/src/prisma/prisma.service';

jest.mock('../apps/api/src/prisma/prisma.service');

describe('GenerationQueueService', () => {
  let service: GenerationQueueService;
  let mockPrisma: any;

  beforeEach(() => {
    mockPrisma = {
      generation: { update: jest.fn().mockResolvedValue({}), findUnique: jest.fn().mockResolvedValue({ user: { userId: 'user1' } }) },
    };
    service = new GenerationQueueService(mockPrisma);
  });

  it('marks generation FAILED on LLM error', async () => {
    jest.doRequire('@slideify/llm', { createLLMProvider: () => ({ generate: jest.fn().mockRejectedValue(new Error('LLM error')) }) });
    const job = { data: { generationId: 'gen1', sourceText: 'test' } };
    await service.process(job);
    expect(mockPrisma.generation.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'gen1' }, data: { status: 'FAILED', error: 'LLM_ERROR' } })
    );
  });
});