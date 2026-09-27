import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { MockProvider } from '../packages/llm/src/providers';
import { SlideSchema, LLMResponseSchema, GenerationInputSchema } from '../packages/shared/src/types';
import { config } from '../packages/config/src/config';

describe('PROMPTS.md contract validation', () => {
  it('MockProvider returns 5-10 slides', async () => {
    const provider = new MockProvider();
    const sourceText = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt in culpa qui officia deserunt mollit anim id est laborum';
    const result = await provider.generate(sourceText);
    expect(result.slides.length).toBeGreaterThanOrEqual(5);
    expect(result.slides.length).toBeLessThanOrEqual(10);
  });

  it('slides conform to SlideSchema', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    result.slides.forEach((slide) => {
      expect(SlideSchema.safeParse(slide).success).toBe(true);
    });
  });

  it('meta.slide_count equals slides.length', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    expect(result.meta.slide_count).toBe(result.slides.length);
  });

  it('meta.source_language is ISO 639-1', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    expect(result.meta.source_language).toMatch(/^[a-z]{2}$/);
  });

  it('each title is <= 60 chars', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    result.slides.forEach((slide) => {
      expect(slide.title.length).toBeLessThanOrEqual(60);
    });
  });

  it('each body is <= 220 chars', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    result.slides.forEach((slide) => {
      expect(slide.body.length).toBeLessThanOrEqual(220);
    });
  });

  it('orders are 1..N without duplicates', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Test texte');
    const orders = result.slides.map((s) => s.order).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      expect(orders[i]).toBe(i + 1);
    }
  });

  it('handles long text without error', async () => {
    const provider = new MockProvider();
    const longText = 'Test '.repeat(500);
    const result = await provider.generate(longText);
    expect(result.slides.length).toBeGreaterThanOrEqual(5);
  });

  it('detects French language from accented characters', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('Voici un texte en français avec des accents');
    expect(result.meta.source_language).toBe('fr');
  });

  it('defaults to English for ASCII text', async () => {
    const provider = new MockProvider();
    const result = await provider.generate('This is an English text with no accents');
    expect(result.meta.source_language).toBe('en');
  });
});

describe('Zod schemas', () => {
  it('GenerationInputSchema rejects short text (< 80 words)', () => {
    const result = GenerationInputSchema.safeParse({ sourceText: 'too short' });
    expect(result.success).toBe(false);
  });

  it('GenerationInputSchema accepts valid text', () => {
    const text = 'word '.repeat(80);
    const result = GenerationInputSchema.safeParse({ sourceText: text });
    expect(result.success).toBe(true);
  });

  it('GenerationInputSchema rejects long text (> 3000 words)', () => {
    const text = 'word '.repeat(3001);
    const result = GenerationInputSchema.safeParse({ sourceText: text });
    expect(result.success).toBe(false);
  });
});

describe('Config', () => {
  it('loads env defaults', () => {
    const cfg = config;
    expect(cfg.nodeEnv).toBe('development');
    expect(cfg.redis.host).toBe('127.0.0.1');
    expect(cfg.redis.port).toBe(6379);
  });
});