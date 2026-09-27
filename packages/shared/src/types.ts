import { z } from 'zod';

// ---- Slide schema (PROMPTS.md contract) ----
export const SlideSchema = z.object({
  order: z.number().int().min(1).max(10),
  title: z.string().min(1).max(60),
  body: z.string().min(1).max(220),
});

// ---- LLM response schema ----
export const LLMResponseSchema = z.object({
  slides: z.array(SlideSchema).min(5).max(10),
  meta: z.object({
    slide_count: z.number().int(),
    source_language: z.string().min(2).max(2),
  }),
});

// ---- Validation types ----
export type Slide = z.infer<typeof SlideSchema>;
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

// ---- Generation input ----
export const GenerationInputSchema = z.object({
  sourceText: z
    .string()
    .min(80, 'Texte trop court — minimum 80 mots')
    .max(3000, 'Texte trop long — maximum 3000 mots'),
});

export type GenerationInput = z.infer<typeof GenerationInputSchema>;

// ---- Generation job payload ----
export const GenerationJobSchema = z.object({
  generationId: z.string(),
  sourceText: z.string(),
});

export type GenerationJob = z.infer<typeof GenerationJobSchema>;

// ---- Generation Status (matches Prisma enum) ----
export enum GenerationStatus {
  QUEUED = 'QUEUED',
  PROCESSING_LLM = 'PROCESSING_LLM',
  PROCESSING_RENDER = 'PROCESSING_RENDER',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
}

// ---- Credit Transaction Types ----
export enum CreditTransactionType {
  GENERATION_DEBIT = 'GENERATION_DEBIT',
  REFUND = 'REFUND',
  MANUAL_GRANT = 'MANUAL_GRANT',
  PROMO = 'PROMO',
  ADJUSTMENT = 'ADJUSTMENT',
}

// ---- Generation Event Names ----
export enum GenerationEventName {
  USER_ACTIVATED = 'user_activated',
  FIRST_GENERATION_COMPLETED = 'first_generation_completed',
}