import { z } from 'zod';

// ---- Compteur de mots (partagé front/back) ----
export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---- Slide schema (PROMPTS.md contract) ----
// trim() avant min(1) : un titre/espace blanc seul est invalide (AO-10).
export const SlideSchema = z.object({
  order: z.number().int().min(1).max(10),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(220),
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
// Bornes métier en MOTS (80–3000), pas en caractères.
// z.string().min/max compte des caractères : inutilisable ici.
// On valide via countWords(), fonction unique partagée front/back (§13).
export const GenerationInputSchema = z.object({
  sourceText: z.string().superRefine((val, ctx) => {
    const words = countWords(val);
    if (words < 80) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Texte trop court — minimum 80 mots',
      });
    }
    if (words > 3000) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Texte trop long — maximum 3000 mots',
      });
    }
  }),
});

export type GenerationInput = z.infer<typeof GenerationInputSchema>;

// ---- Generation job payload ----
// Contrat réel M004 : seul generationId transite par BullMQ.
// Le worker relit sourceText/userId depuis PostgreSQL (SC-07, AZ-06).
export const GenerationJobSchema = z.object({
  generationId: z.string(),
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

// ---- Credit Transaction (partage du modèle allégé) ----
export interface CreditTransaction {
  id: string;
  userId: string;
  amount: number; // positif = crédit, négatif = débit
  type: CreditTransactionType;
  reference?: string; // génération id, session Stripe id
  metadata?: unknown;
  createdAt: Date;
}

// ---- Generation Event Names ----
export enum GenerationEventName {
  USER_ACTIVATED = 'user_activated',
  FIRST_GENERATION_COMPLETED = 'first_generation_completed',
}