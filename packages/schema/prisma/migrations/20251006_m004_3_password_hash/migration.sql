-- M004.3: credential-based auth. Adds bcrypt password hash to User.
-- NOTE: applied to a fresh chain (no production database exists yet).
-- Any pre-existing dev database must be reset (`prisma migrate reset`)
-- because existing rows have no hash.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT NOT NULL;
