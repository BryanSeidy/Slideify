import { z } from 'zod';

// ---- Compteur de mots (partagé front/back) ----
export function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * D-04 — Validation en deux couches.
 *
 * `LLMSlideSchema` valide la STRUCTURE et des plafonds de sécurité larges :
 * un titre de 61 caractères ou un corps de 235 caractères est valide ici,
 * puis tronqué par le worker avant persistance. `SlideSchema` reste le
 * contrat de persistance (≤ 60 / ≤ 220), utilisé après troncature.
 */
export const LLMSlideSchema = z.object({
  order: z.number().int(),
  title: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(1100),
});
// Les champs inconnus sont retirés (pas de `passthrough`) : jamais persistés.

export const LLMResponseSchema = z.object({
  slides: z.array(LLMSlideSchema).min(5).max(10),
  meta: z.object({
    slide_count: z.number().int(),
    // D-05 : la VALEUR ne bloque jamais (ni "fr-FR", ni "French", ni "").
    // Seul un type non-chaîne est une erreur de structure.
    source_language: z.string(),
  }),
});

/** Contrat de persistance (après troncature par le worker). */
export const SlideSchema = z.object({
  order: z.number().int().min(1).max(10),
  title: z.string().trim().min(1).max(60),
  body: z.string().trim().min(1).max(220),
});

export type Slide = z.infer<typeof SlideSchema>;
export type LLMResponse = z.infer<typeof LLMResponseSchema>;

// ---- Generation input ----
// Bornes métier en MOTS (80–3000), pas en caractères.
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
// Contrat M004/M006 : seul generationId transite par BullMQ. `.strict()`
// garantit qu'un payload contenant sourceText/userId est rejeté.
export const GenerationJobSchema = z.object({
  generationId: z.string().min(1),
}).strict();

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
