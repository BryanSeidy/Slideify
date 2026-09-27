# MILESTONE 003 — Production-Ready MVP

## OBJECTIF

Rendre le codebase MVP (MVP Core — Generation de base : texte URL → PDF simple, 1 template) **production-ready** en corrigeant les bugs critiques et en implémentant les fonctionnalités manquantes pour permettre le lancement.

---

## SCOPE

**À implémenter :**

### Backend API (NestJS)
- [ ] Auth JWT réel avec Supabase magic link (ou fallback mock pour dev)
- [ ] Validation des inputs avec Zod pipes
- [ ] CreditConsumption dans transaction Prisma
- [ ] Webhook Stripe signature validation
- [ ] Error handling global (Exception filters)
- [ ] Structured logging (Pino)

### Database (Prisma)
- [ ] Mettre à jour schéma avec CreditTransaction (append-only ledger)
- [ ] Mettre à jour schéma avec GenerationEvent
- [ ] Migration initiale

### Worker (BullMQ)
- [ ] Error handling robuste (catch undefined errors)
- [ ] Transaction pour génération COMPLETED + credit debit
- [ ] Timeout handling (90s max)
- [ ] Retry policy correcte

### Frontend (Next.js)
- [ ] Auth hook avec JWT réel
- [ ] API client intégré
- [ ] États de chargement UX conformes spec

### Infrastructure
- [ ] CI/CD GitHub Actions fonctionnels
- [ ] Docker Compose prod-ready
- [ ] Health checks

### Sécurité
- [ ] Rate limiting API
- [ ] Input validation pipes
- [ ] CORS configuré correctement
- [ ] Secrets validation

### Tests
- [ ] Tests intégration API
- [ ] Tests E2E génération complète

---

## OUT OF SCOPE

- URL extraction (P1)
- Multi-templates (P1)
- Légendes/hashtags (P1)
- Abonnements (Future)
- Analytics avancés (Future)
- Cache (Future)

---

## DATABASE CHANGES

### Nouvelle Migration

Fichier : `packages/schema/prisma/migrations/20240927000000_credit_ledger/migration.sql`

```sql
-- Créer CreditTransaction (append-only)
CREATE TABLE "CreditTransaction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),

    CONSTRAINT "CreditTransaction_pkey" PRIMARY KEY ("id")
);

-- Créer indexes
CREATE INDEX "CreditTransaction_userId_idx" ON "CreditTransaction"("userId");
CREATE INDEX "CreditTransaction_createdAt_idx" ON "CreditTransaction"("createdAt");

-- Créer contrainte check amount non-null
ALTER TABLE "CreditTransaction" ADD CONSTRAINT "CreditTransaction_amount_check" CHECK ("amount" != 0);

-- Créer enum
CREATE TYPE "CreditTransactionType" AS ENUM ('GENERATION_DEBIT', 'REFUND', 'MANUAL_GRANT', 'PROMO', 'ADJUSTMENT');

-- Supprimer ancienne table Credit si elle existe
DROP TABLE IF EXISTS "Credit";
```

### Schema Mise à Jour

```prisma
// Supprimer User.creditId et User.credits
// Ajouter CreditTransaction et GenerationEvent

model User {
  id                 String              @id @default(cuid())
  email              String              @unique
  createdAt          DateTime            @default(now())
  updatedAt          DateTime            @updatedAt

  creditTransactions CreditTransaction[]
  generations        Generation[]
  events             GenerationEvent[]
}

model CreditTransaction {
  id        String                @id @default(cuid())
  userId    String
  user      User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  amount    Int
  type      CreditTransactionType
  reference String?
  metadata  Json?
  createdAt DateTime              @default(now())
}

enum CreditTransactionType {
  GENERATION_DEBIT
  REFUND
  MANUAL_GRANT
  PROMO
  ADJUSTMENT
}
```

---

## API CHANGES

### Nouveaux Endpoints

```
POST   /auth/magic-link     → envoyer mail magic link (Supabase ou mock)
POST   /auth/verify         → vérifier token, retourner JWT
GET    /me                  → retourner user + credits (JWT guard)
POST   /generations         → créer job, valider input, créer Generation
GET    /generations/:id     → statut (auth requis)
GET    /generations         → liste user
POST   /payment/checkout    → créer session Stripe (JWT guard)
POST   /payment/webhook     → traiter webhook (idempotent)
GET    /health              → ping
```

### Auth Flow Nouveau

1. POST `/auth/magic-link` → frontend envoie email → backend génère token JWT → envoie mail (mock ou Supabase)
2. Utilisateur clique mail → redirige vers `/auth/callback?token=X`
3. Frontend vérifie token, sauvegarde JWT dans localStorage
4. Tous les appels API incluent `Authorization: Bearer <JWT>`

---

## WORKER CHANGES

### Fichier : `apps/worker/src/index.ts`

Modifications nécessaires :

1. **Import GenerationStatus** depuis `@slideify/schema` ou définir localement
2. **Transaction pour credit** :
```typescript
await prisma.$transaction([
  prisma.generation.update({ /* COMPLETED */ }),
  prisma.creditTransaction.create({ /* debit */ })
]);
```

3. **Error handling** :
```typescript
catch ((error: unknown)) {
  const message = error instanceof Error ? error.message : 'Unknown error';
  logger.error(message);
}
```

4. **Timeout check** dans job process

---

## TESTS

### Tests à ajouter

1. **Integration tests** :
   - POST /generations avec texte valide/invalide
   - GET /generations/:id/status → transitions
   - POST /payment/webhook idempotence

2. **E2E tests** :
   - Flow complet : créer user → créer génération → polling → résultat → téléchargement

3. **Unit tests** :
   - MockProvider → JSON valide
   - Validation pipeline
   - CreditBalance calculation

### Fichier de tests existants à corriger

- `tests/generation.test.ts` — MockProvider import invalide
- `tests/schema.test.ts` — schema peut être invalide

---

## ACCEPTANCE CRITERIA

### Auth
- [ ] Magic link fonctionne (mock en dev)
- [ ] JWT retourné et validé
- [ ] Expiration 1h
- [ ] Email déjà utilisé → idem flux

### Generation
- [ ] 3 mot min / 3000 mot max
- [ ] 5-10 slides générés
- [ ] title ≤ 60, body ≤ 220
- [ ] Crédit débité à COMPLETED
- [ ] Crédit NON débité si FAILED

### Payment
- [ ] Webhook idempotent
- [ ] 20 crédits ajoutés après checkout.session.completed

### UX
- [ ] Loading states visibles
- [ ] Error messages en français
- [ ] Pas de stack trace exposée

---

## EDGE CASES

| Cas | Comportement attendu |
|-----|---------------------|
| User supprimé pendant génération | Job FAIL, crédit non débité |
| Double clic "Générer" | Deux jobs, deux crédits débités (à éviter) → dedupe par user+texte+status |
| Webhook Stripe reçu 2x | 2nd reçu ignoré, crédit pas double |
| Worker crash pendant traitement | Job reprise automatique (BullMQ) |
| Redis down | Jobs s'accumulent, reconnection automatique |
| DB down | Job FAIL, retry BullMQ |

---

## SECURITY REQUIREMENTS

1. **Rate limiting** — POST /generations : max 20/min/user
2. **JWT secret** — force minimum 32 chars en prod
3. **Webhook validation** — vérifier signature Stripe `v1`
4. **Input sanitization** — Zod validation sur tous les inputs
5. **Credit debits** — transactionnel, idempotent

---

## DEFINITION OF DONE

Pour valider ce milestone :

1. ✅ Tous les tests passent (`npm run test`)
2. ✅ Lint passe (`npm run lint`)
3. ✅ Typecheck passe (`npm run typecheck`)
4. ✅ Build fonctionnel (`npm run build`)
5. ✅ Docker Compose setup:
   - `docker compose up` démarre tout
   - API accessible sur http://localhost:3001/api/health = `{status: "ok"}`
   - Worker traite les jobs
   - Base de données migrée
6. ✅ Démonstration flow complet :
   - User s'inscrit → 3 crédits offerts
   - User crée génération avec 80-3000 mots
   - Résultat affiché
   - Crédit débité
7. ✅ README.md met à jour avec procédure de setup
8. ✅ CI/CD GitHub Actions passe sur main

---

## WORKFLOW DE DÉVELOPPEMENT

```bash
# 1. Setup
cp .env.example .env
docker compose up -d
pnpm install
pnpm run db:generate
pnpm run db:push

# 2. Dev
pnpm run dev       # API + Web
pnpm run worker    # Worker en parallèle

# 3. Test
pnpm run test

# 4. Build
pnpm run build

# 5. Commit
git add .
git commit -m "feat: <description>"
git push
```

---

## DÉPENDANCES MANSANTES

| Package | Raison |
|---------|--------|
| `@supabase/supabase-js` | Magic link fallback |
| `jsonwebtoken` | JWT sign/verify |
| `zod` | Validation (déjà présent) |
| `bullmq` | Queue (déjà présent) |
| `puppeteer` | Rendering (déjà présent) |
| `stripe` | Webhook validation |
| `pino` | Structured logging |
| `@nestjs/throttler` | Rate limiting |
| `dotenv` | Env vars (déjà présent) |

---

## Décisions à Valider

1. **Auth provider** : Supabase Auth vs implémentation maison ?
   - Recommandé : Implémentation maison avec JWT (moins de dépendances)

2. **Storage** : Local filesystem vs S3 ?
   - MVP : Local filesystem (localStorageAdapter exists)
   - Future : S3 pour prod

3. **Température du modèle** : 0.3 (actuel) convient-il ?
   - Oui, pour cohérence du texte

4. **Timeout BullMQ** : 90s convient-il ?
   - Oui, mais ajouter back-off configurables