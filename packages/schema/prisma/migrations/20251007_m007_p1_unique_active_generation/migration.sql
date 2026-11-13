-- M007 P1.1 — Une seule génération non terminale par utilisateur
-- Index unique partiel : au plus une ligne QUEUED/PROCESSING_LLM/PROCESSING_RENDER par userId.
CREATE UNIQUE INDEX IF NOT EXISTS "Generation_userId_active_unique" ON "Generation"("userId") WHERE "status" IN ('QUEUED', 'PROCESSING_LLM', 'PROCESSING_RENDER');

-- M007 P1.3 — Contraintes d'intégrité du ledger Crédit
-- 1. reference doit être non nulle pour un GENERATION_DEBIT (NULL contournerait l'unicité en PostgreSQL).
ALTER TABLE "CreditTransaction" ALTER COLUMN "reference" SET NOT NULL;

-- 2. Un GENERATION_DEBIT a forcément amount = -1.
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_amount_check"
  CHECK (NOT (type = 'GENERATION_DEBIT' AND amount <> -1));

-- 3. Un GENERATION_DEBIT a forcément une reference non vide.
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_reference_check"
  CHECK (NOT (type = 'GENERATION_DEBIT' AND reference IS NULL OR reference = ''));

-- Index pour le réconciliateur : générations bloquées en PROCESSING_* depuis trop longtemps.
CREATE INDEX IF NOT EXISTS "Generation_status_createdAt_idx" ON "Generation"("status", "createdAt");
