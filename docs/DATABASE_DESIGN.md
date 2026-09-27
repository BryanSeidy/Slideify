# Database Design — Slideify MVP

## Schéma Final (Prisma)

### Models

```prisma
model User {
  id                 String              @id @default(cuid())
  email              String              @unique
  createdAt          DateTime            @default(now())
  updatedAt          DateTime            @updatedAt

  creditTransactions CreditTransaction[]
  generations        Generation[]
  events             GenerationEvent[]

  @@index [email]
}

model CreditTransaction {
  id        String                @id @default(cuid())
  userId    String
  user      User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  amount    Int                   // positif = crédit, négatif = débit
  type      CreditTransactionType
  reference String?               // generation id, session Stripe id
  metadata  Json?
  createdAt DateTime              @default(now())

  @@index [userId]
  @@index [createdAt]
}

enum CreditTransactionType {
  GENERATION_DEBIT  // -1 quand génération COMPLETED
  REFUND            // +N pour remboursement
  MANUAL_GRANT      // +N pour crédit gratuit à l'inscription
  PROMO             // +N pour code promo
  ADJUSTMENT        // +N ou -N pour correction manuelle
}

model Generation {
  id          String            @id @default(cuid())
  userId      String
  user        User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  sourceText  String            // texte brut ≤ 3000 mots
  status      GenerationStatus  @default(QUEUED)
  slideCount  Int?
  error       String?
  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime          @default(now())
  updatedAt   DateTime          @updatedAt

  outputs     Output[]
  events      GenerationEvent[]

  @@index [userId]
  @@index [status]
  @@index [createdAt]
}

enum GenerationStatus {
  QUEUED
  PROCESSING_LLM
  PROCESSING_RENDER
  COMPLETED
  FAILED
}

model Output {
  id           String       @id @default(cuid())
  generationId String
  generation   Generation   @relation(fields: [generationId], references: [id], onDelete: Cascade)
  format       OutputFormat
  url          String
  expiresAt    DateTime
  size         Int          // taille en octets
  createdAt    DateTime     @default(now())

  @@index [generationId]
  @@index [expiresAt]
}

enum OutputFormat {
  PNG
  ZIP
  PDF
}

model GenerationEvent {
  id        String   @id @default(cuid())
  name      String   // "user_activated", "first_generation_completed"
  actorId   String
  actor     User     @relation(fields: [actorId], references: [id], onDelete: Cascade)
  metadata  Json?
  createdAt DateTime @default(now())

  @@index [actorId]
  @@index [name]
  @@index [createdAt]
}
```

---

## Entity Relationship Diagram

```
┌──────────┐
│   User   │
│  (root)  │
└────┬─────┘
     │ 1..N
     ├── CreditTransaction (append-only ledger)
     │    amount: int (signed)
     │    type: enum
     │    reference?: string
     │
     ├── Generation (1..N)
     │    │
     │    └── Output (1..N)
     │
     └── GenerationEvent (1..N, activation tracking)
```

---

## Indexes

| Table | Columns | Purpose |
|-------|---------|---------|
| User | `email` | Login lookup |
| CreditTransaction | `userId`, `createdAt` | Balance calculation + history |
| Generation | `userId`, `status`, `createdAt` | Dashboard display |
| Generation | `status`, `startedAt` | Worker monitoring |
| Output | `generationId`, `expiresAt` | Asset retrieval + cleanup |
| GenerationEvent | `actorId`, `name`, `createdAt` | Activation analytics |

---

## Constraints

| Constraint | Description |
|------------|-------------|
| `User.email` unique | Pas de doublons d'email |
| `Generation.userId` FK cascade | Suppression user = suppression génération |
| `Output.generationId` FK cascade | Suppression génération = suppression outputs |
| `CreditTransaction.amount` non-zero | Pas de transaction à 0 |
| `CreditTransaction.amount` signed | Positif = crédit, Négatif = débit |
| `Generation.status` default QUEUED | Toujours initialisé |
| `CreditTransaction` append-only | Aucune update/delete possible (enforced par app logic) |

---

## Credit Balance Calculation

Le solde n'est PAS stocké — il est calculé:

```sql
SELECT COALESCE(SUM(amount), 0)
FROM "CreditTransaction"
WHERE "userId" = $1;
```

**Avantages** :
- Audit trail complet
- Reconstructible à tout moment
- Protection contre les race conditions (somme atomique)

**Inconvénients** :
- Requête potentiellement lourde si beaucoup de transactions
- **Mitigation** : Index sur `(userId, createdAt)`, et le nombre de transactions/user reste < 10K en MVP

---

## Migration Strategy

1. **Initial migration** : Créer tous les modèles
2. **Seed data** : Aucun (utilisateurs créés via auth flow)
3. **Future migrations** : Ajout de `Subscription`, `Payment`, etc. sans toucher au modèle existant

---

## Notes sur l'évolution future

- UUID vs cuid : garder cuid pour l'instant, ajouter `externalId: String @unique` si besoin d'UUID public
- Audit log : `GenerationEvent` peut être étendu
- Analytics : créer des vues Matériaux si besoin de stats en temps réel
- Multi-tenant : pas prévu pour MVP, ajouter `organizationId` sur User si besoin

---

## Décisions de Conception

1. **CreditTransaction = append-only ledger** — pas de `balance` mutable sur User
2. **GenerationEvent** — table d'events pour activité tracking
3. **No `Credit` table** — le solde est calculé depuis les transactions
4. **Cascade delete** — garder pour clean up, mais watch pour data loss en prod
5. **cuid** — gardé pour simplicité, migration vers UUID si besoin d'obfuscation d'IDs