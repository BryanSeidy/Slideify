-- M007 P1.1 — Une seule génération non terminale par utilisateur
-- Index unique partiel : au plus une ligne QUEUED/PROCESSING_LLM/PROCESSING_RENDER par userId.
CREATE UNIQUE INDEX IF NOT EXISTS "Generation_userId_active_unique" ON "Generation"("userId") WHERE "status" IN ('QUEUED', 'PROCESSING_LLM', 'PROCESSING_RENDER');

-- M007 P1.3 — Contraintes d'intégrité du ledger Crédit
-- Backfill déterministe : l'id de ligne garantit l'unicité de (userId, type,
-- reference) même pour des données historiques sans référence.
UPDATE "CreditTransaction"
SET "reference" = CASE
  WHEN "type" = 'GENERATION_DEBIT' THEN 'legacy-debit:' || "id"
  ELSE 'legacy-' || lower("type"::text) || ':' || "id"
END
WHERE "reference" IS NULL OR "reference" = '';

ALTER TABLE "CreditTransaction" ALTER COLUMN "reference" SET NOT NULL;

-- 1. Un GENERATION_DEBIT a forcément amount = -1.
ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS "Credit_debit_amount_check";
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_amount_check"
  CHECK (NOT ("type" = 'GENERATION_DEBIT' AND "amount" <> -1));

-- 2. Un GENERATION_DEBIT a forcément une reference non vide (les parenthèses
--    comptent : sans elles, l'ancienne contrainte laissait passer '').
ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS "Credit_debit_reference_check";
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_reference_check"
  CHECK (NOT ("type" = 'GENERATION_DEBIT' AND ("reference" IS NULL OR "reference" = '')));

-- Index pour le réconciliateur : générations bloquées en statut non terminal.
CREATE INDEX IF NOT EXISTS "Generation_status_createdAt_idx" ON "Generation"("status", "createdAt");
