-- M007.1 — Migration safety and idempotency repair.
-- Applied by Prisma Migrate as a single transaction on PostgreSQL.

-- 0. Reconcile historical duplicate ACTIVE generations before creating the
--    partial unique index. Deterministic winner:
--      1. most advanced status (PROCESSING_RENDER > PROCESSING_LLM > QUEUED)
--      2. earliest createdAt
--      3. lowest id
--    Losers become FAILED/M007_DUPLICATE_ACTIVE_GENERATION. No credits are
--    debited for those rows and late BullMQ jobs skip terminal rows.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY
        CASE "status"
          WHEN 'PROCESSING_RENDER' THEN 3
          WHEN 'PROCESSING_LLM' THEN 2
          WHEN 'QUEUED' THEN 1
          ELSE 0
        END DESC,
        "createdAt" ASC,
        "id" ASC
    ) AS rn
  FROM "Generation"
  WHERE "status" IN ('QUEUED', 'PROCESSING_LLM', 'PROCESSING_RENDER')
)
UPDATE "Generation"
SET "status" = 'FAILED',
    "error" = 'M007_DUPLICATE_ACTIVE_GENERATION',
    "updatedAt" = NOW()
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- Reconcile duplicate user_activated events before enforcing one per actor.
WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "actorId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "GenerationEvent"
  WHERE "name" = 'user_activated'
    AND "actorId" IS NOT NULL
)
DELETE FROM "GenerationEvent"
WHERE "id" IN (SELECT "id" FROM ranked WHERE rn > 1);

-- 1. Detect adversarial reference collisions before any backfill.
DO $$
DECLARE collision_count integer;
BEGIN
  SELECT count(*) INTO collision_count
  FROM (
    SELECT
      "userId",
      "type",
      COALESCE(
        NULLIF("reference", ''),
        CASE
          WHEN "type" = 'GENERATION_DEBIT' THEN 'legacy-debit:' || "id"
          ELSE 'legacy-' || lower("type"::text) || ':' || "id"
        END
      ) AS proposed_reference
    FROM "CreditTransaction"
    GROUP BY "userId", "type", proposed_reference
    HAVING count(*) > 1
  ) collisions;

  IF collision_count > 0 THEN
    RAISE EXCEPTION 'M007_REFERENCE_COLLISION: % proposed reference collision(s)', collision_count;
  END IF;
END $$;

-- 2. Never silently rewrite financial amounts. Abort before schema changes.
DO $$
DECLARE invalid_debit_count integer;
BEGIN
  SELECT count(*) INTO invalid_debit_count
  FROM "CreditTransaction"
  WHERE "type" = 'GENERATION_DEBIT'
    AND "amount" <> -1;

  IF invalid_debit_count > 0 THEN
    RAISE EXCEPTION 'M007_INVALID_HISTORICAL_DEBIT_AMOUNT: % GENERATION_DEBIT row(s) with amount <> -1', invalid_debit_count;
  END IF;
END $$;

-- 3. Deterministic backfill for missing references.
UPDATE "CreditTransaction"
SET "reference" = CASE
  WHEN "type" = 'GENERATION_DEBIT' THEN 'legacy-debit:' || "id"
  ELSE 'legacy-' || lower("type"::text) || ':' || "id"
END
WHERE "reference" IS NULL OR "reference" = '';

ALTER TABLE "CreditTransaction" ALTER COLUMN "reference" SET NOT NULL;

-- 4. Ledger CHECK constraints. Parentheses are mandatory.
ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS "Credit_debit_amount_check";
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_amount_check"
  CHECK (NOT ("type" = 'GENERATION_DEBIT' AND "amount" <> -1));

ALTER TABLE "CreditTransaction" DROP CONSTRAINT IF EXISTS "Credit_debit_reference_check";
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "Credit_debit_reference_check"
  CHECK (NOT ("type" = 'GENERATION_DEBIT' AND ("reference" IS NULL OR "reference" = '')));

-- 5. One active generation per user.
CREATE UNIQUE INDEX IF NOT EXISTS "Generation_userId_active_unique"
  ON "Generation"("userId")
  WHERE "status" IN ('QUEUED', 'PROCESSING_LLM', 'PROCESSING_RENDER');

-- 6. One user_activated event per actor.
CREATE UNIQUE INDEX IF NOT EXISTS "GenerationEvent_actorId_user_activated_unique"
  ON "GenerationEvent"("actorId")
  WHERE "name" = 'user_activated';

-- 7. Reaper support.
CREATE INDEX IF NOT EXISTS "Generation_status_createdAt_idx"
  ON "Generation"("status", "createdAt");
