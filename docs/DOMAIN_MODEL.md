# Domain Model — Slideify MVP

## Agrégats et Relations

### 1. User (Agrégat Racine)

**Responsabilité** : Identité, crédits, historique

**Identité** : `id` (cuid), `email` (unique)

**Champs essentiels** :
- `id: string` (PK)
- `email: string` (unique)
- `createdAt: DateTime`
- `updatedAt: DateTime`

**Relations** :
- 1..1 → Credit (solde)
- 1..N → Generation (historique)

**Invariants** :
- Email unique et non vide
- Toujours lié à exactement 1 Credit record
- Chaque génération est rattachée à un utilisateur

**Données immuables** :
- `id`, `email`, `createdAt`

**Données mutables** :
- `updatedAt` (automatique)

---

### 2. Generation (Agrégat Racine)

**Responsabilité** : Cycle de vie d'une génération de carrousel

**Identité** : `id` (cuid)

**Champs essentiels** :
- `id: string` (PK)
- `userId: string` (FK → User)
- `sourceText: string` (texte brut, ≤ 3000 mots)
- `status: GenerationStatus`
- `slideCount: int?`
- `error: string?`
- `startedAt: DateTime?`
- `completedAt: DateTime?`
- `createdAt: DateTime`
- `updatedAt: DateTime`

**Relations** :
- N..1 → User
- 1..N → Output (résultats)
- 1..N → GenerationEvent (historique d'états)

**Invariants** :
- Status suit un lifecycle strict (cf. GENERATION_LIFECYCLE.md)
- Au plus N outputs par génération (1 ZIP + 1 PDF en MVP)
- Une génération terminée ne peut pas revenir à QUEUED
- Un crédit est consommé seulement à COMPLETED

**Données immuables** :
- `id`, `userId`, `sourceText`, `createdAt`

**Données mutables** :
- `status`, `slideCount`, `error`, `startedAt`, `completedAt`, `updatedAt`

---

### 3. Output (Entité Valeur)

**Responsabilité** : Asset résultant d'une génération

**Identité** : `id` (cuid)

**Champs essentiels** :
- `id: string` (PK)
- `generationId: string` (FK → Generation)
- `format: OutputFormat` (PNG | ZIP | PDF)
- `url: string` (URL signée, expiration)
- `expiresAt: DateTime`
- `size: int` (octets)
- `createdAt: DateTime`

**Relations** :
- N..1 → Generation

**Invariants** :
- URL non vide
- expiresAt > createdAt
- format ∈ {PNG, ZIP, PDF}

**Données immuables** :
- `id`, `generationId`, `format`, `url`, `expiresAt`, `size`, `createdAt`

---

### 4. GenerationEvent (Entité)

**Responsabilité** : Journal d'activation (première génération COMPLETED)

**Identité** : `id` (cuid)

**Champs essentiels** :
- `id: string` (PK)
- `name: string` (nom de l'événement)
- `actorId: string` (FK → User, qui a déclenché)
- `metadata: Json` (données supplémentaires)
- `createdAt: DateTime`

**Relations** :
- N..1 → User (actor)

**Invariants** :
- name non vide
- actorId doit référencer un User existant
- createdAt = now() au moment de la création

**Données immuables** :
- TOUT (journal append-only)

---

### 5. CreditTransaction (Entité — Append-Only Ledger)

**Responsabilité** : Historique immuable des crédits

**Identité** : `id` (cuid)

**Champs essentiels** :
- `id: string` (PK)
- `userId: string` (FK → User)
- `amount: int` (signé : positif = crédit, négatif = débit)
- `type: CreditTransactionType`
- `reference: string?` (id de génération, id de session Stripe)
- `metadata: Json?`
- `createdAt: DateTime`

**Relations** :
- N..1 → User

**Invariants** :
- amount ≠ 0
- type ∈ {GENERATION_DEBIT, REFUND, MANUAL_GRANT, PROMO, ADJUSTMENT}
- reference optionnelle mais traçable
- createdAt = now() au moment de la création
- **Append-only : aucune mise à jour ou suppression**

**Données immuables** :
- **TOUT** (c'est un ledger)

**Calcul du solde** :
```sql
SELECT COALESCE(SUM(amount), 0) FROM credit_transactions WHERE userId = ?;
```

---

## Résumé des Relations

```
User ||--o{ Generation : "a"
User ||--|| CreditTransaction : "credit ledger"
User ||--o{ GenerationEvent : "déclenche"
Generation ||--o{ Output : "produit"
Generation ||--o{ GenerationEvent : "traverse"
```

## Decisions de Conception

1. **CreditTransaction = append-only ledger** : Pas de solde mutable, reconstruction via somme
2. **GenerationEvent** : Table de events pour traçabilité (activation tracking)
3. **Output** : Entité séparée pour permettre expiration/régénération de lien
4. **User** : Agrégat racine avec Credit et Generations comme sous-entités

## Non-Modélisé (hors MVP)
- Paiement (pas de modèle Payment, juste webhook handler)
- Abonnement (pas de Subscription model)
- Teams/Organizations
- Analytics complexes
- Templates
- URL extraction

---

## Schéma Prisma

```prisma
model User {
  id            String               @id @default(cuid())
  email         String               @unique
  createdAt     DateTime             @default(now())
  updatedAt     DateTime             @updatedAt

  creditTransactions CreditTransaction[]
  generations  Generation[]
  events       GenerationEvent[]
}

model CreditTransaction {
  id        String                @id @default(cuid())
  userId    String
  user      User                  @relation(fields: [userId], references: [id], onDelete: Cascade)
  amount    Int                   // positif = crédit, négatif = débit
  type      CreditTransactionType
  reference String?               // id de generation, id de session Stripe
  metadata  Json?
  createdAt DateTime              @default(now())

  @@index [userId]
  @@index [createdAt]
}

enum CreditTransactionType {
  GENERATION_DEBIT
  REFUND
  MANUAL_GRANT
  PROMO
  ADJUSTMENT
}

model Generation {
  id          String               @id @default(cuid())
  userId      String
  user        User                 @relation(fields: [userId], references: [id], onDelete: Cascade)
  sourceText  String
  status      GenerationStatus     @default(QUEUED)
  slideCount  Int?
  error       String?
  startedAt   DateTime?
  completedAt DateTime?
  createdAt   DateTime             @default(now())
  updatedAt   DateTime             @updatedAt

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
  id          String         @id @default(cuid())
  generationId String
  generation  Generation     @relation(fields: [generationId], references: [id], onDelete: Cascade)
  format      OutputFormat
  url         String
  expiresAt   DateTime
  size        Int
  createdAt   DateTime       @default(now())

  @@index [generationId]
  @@index [expiresAt]
}

enum OutputFormat {
  PNG
  ZIP
  PDF
}

model GenerationEvent {
  id        String      @id @default(cuid())
  name      String      // "activation", "first_generation_completed", etc.
  actorId   String
  actor     User        @relation(fields: [actorId], references: [id], onDelete: Cascade)
  metadata  Json?
  createdAt DateTime    @default(now())

  @@index [actorId]
  @@index [name]
}
```

Ce schéma remplace celui de `packages/schema/prisma/schema.prisma`.