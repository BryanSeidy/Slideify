import { countWords, GenerationJobSchema, GenerationInputSchema } from '../packages/shared/src/types';

describe('Generation input contract (M004 §13)', () => {
  const words = (n: number) => 'word '.repeat(n).trim();

  it('79 words → rejected', () => {
    expect(countWords(words(79))).toBe(79);
    expect(GenerationInputSchema.safeParse({ sourceText: words(79) }).success).toBe(false);
  });

  it('80 words → accepted', () => {
    expect(countWords(words(80))).toBe(80);
    expect(GenerationInputSchema.safeParse({ sourceText: words(80) }).success).toBe(true);
  });

  it('3000 words → accepted', () => {
    expect(GenerationInputSchema.safeParse({ sourceText: words(3000) }).success).toBe(true);
  });

  it('3001 words → rejected', () => {
    expect(GenerationInputSchema.safeParse({ sourceText: words(3001) }).success).toBe(false);
  });
});

describe('Generation job payload contract (M004 §24)', () => {
  it('accepts { generationId } only', () => {
    expect(GenerationJobSchema.safeParse({ generationId: 'gen_123' }).success).toBe(true);
  });

  it('rejects missing generationId', () => {
    expect(GenerationJobSchema.safeParse({}).success).toBe(false);
    expect(GenerationJobSchema.safeParse({ sourceText: 'leaked text' }).success).toBe(false);
  });
});
