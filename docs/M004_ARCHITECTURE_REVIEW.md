# M004 Architecture Review — Slideify

**Date:** 2026-09-30
**Purpose:** Senior architecture review BEFORE M004 implementation
**Rule:** NE CODE PAS — review only

---

## 1. Current State Summary

| Layer | Files | Status |
|-------|-------|--------|
| Prisma Schema | `packages/schema/prisma/schema.prisma` | Good foundation, but missing `Credit` model referenced in payment controller |
| Shared Types | `packages/shared/src/types.ts` | Solid Zod schemas + enums |
| LLM Provider | `packages/llm/src/providers.ts` | Clean interface, MockProvider + OpenRouterProvider |
| Renderer | `packages/renderer/src/` | Puppeteer rendering + LocalStorageAdapter |
| API | `apps/api/src/` | NestJS, JWT auth, but GenerationService is coupled to worker concerns |
| Worker | `apps/worker/src/index.ts` | Standalone BullMQ worker |
| Worker (Nest) | `apps/api/src/worker/worker.service.ts` | **DUPLICATE** of worker/src/index.ts logic |
| Config | `packages/config/src/` | Zod env validation, clean config object |
| Credits | `apps/api/src/credits/credits.service.ts` | Append-only ledger, correct |
| Auth | `apps/api/src/auth/` | Magic link + JWT, correct |

---

## 2. Recommended Implementation Flow

```
POST /generations
  → GenerationController.create()        # API layer: validate, own + enqueue
  → GenerationService.create()           # Domain: create record + enqueue job
  → BullMQ Job { generationId }          # Queue: minimal payload
  ↓
Worker picks up job
  → GenerationStatus.checkLocked(generationId)  # Atomic: update status to PROCESSING only if still QUEUED
  → AIProvider.generate(sourceText)       # Domain: call LLM (Mock or OpenRouter)
  → LLMResponseSchema.parse(llmResult)   # Validation: Zod schema in shared
  → renderSlides(validated.slides)       # Domain: render to PNG buffers
  → StorageAdapter.upload(slide files)   # Infrastructure: store files
  → Prisma.$transaction([                # DB: atomic completion
      generation.update(COMPLETED),
      creditTransaction.create(GENERATION_DEBIT),
      generationEvent.create(FIRST_GENERATION_COMPLETED?),
      output.create(records for each slide)
    ])
  ↓
COMPLETED → activation event emitted
```

---

## 3. Domain Boundaries

```
┌─────────────────────────────────────────────┐
│  API Layer (NestJS)                         │
│  - Controllers: auth, generation, payment   │
│  - Guards: JwtAuthGuard                     │
│  - NO business logic                        │
│  - NO LLM/renderer/storage imports          │
├─────────────────────────────────────────────┤
│  Domain Layer (packages)                    │
│  - @slideify/shared: types, schemas, enums  │
│  - @slideify/llm: AIProvider interface      │
│  - @slideify/renderer: render + storage     │
│  - @slideify/config: config, isMockProvider │
│  - @slideify/schema: PrismaClient           │
├─────────────────────────────────────────────┤
│  Worker Layer (apps/worker)                 │
│  - BullMQ Worker processor                  │
│  - Orchestrates domain calls                │
│  - Manages status transitions               │
│  - Handles retries, dead letters            │
├─────────────────────────────────────────────┤
│  Infrastructure                             │
│  - PostgreSQL (Prisma)                      │
│  - Redis (BullMQ)                           │
│  - OpenRouter API                           │
│  - Puppeteer (rendering)                    │
│  - LocalStorage / S3                        │
└─────────────────────────────────────────────┘
```

**Boundary rules:**
- API layer imports domain layer, never infrastructure
- Worker layer imports domain layer, never API layer
- Domain layer has zero external dependencies (no DB, no Redis, no HTTP)
- `GenerationService` in API should NOT import `createLLMProvider`, `renderSlides`, or `StorageAdapterFactory`

---

## 4. Database Invariants

| Invariant | How to enforce |
|-----------|---------------|
| Credit balance ≥ 0 | Check before debit: `SUM(amount) >= 1` before creating debit |
| One credit debit per generation | `reference` field unique per generationId in CreditTransaction |
| Generation status lifecycle | `QUEUED → PROCESSING_LLM → PROCESSING_RENDER → COMPLETED|FAILED` |
| No double-processing | Atomic `updateMany` with `where: { id, status: QUEUED }` |
| Output records for every completed generation | Transaction: generation update + output creates together |
| User exists before generation | FK constraint in Prisma (already defined) |

**Critical missing model:** `payment.controller.ts` references `this.prisma.credit.findUnique` but there is NO `Credit` model in the Prisma schema — only `CreditTransaction`. Either add a `Credit` model or fix the controller to use the ledger aggregation.

**Recommended schema additions:**
```prisma
model Credit {
  id     String @id @default(cuid())
  userId String @unique
  balance Int   @default(0)
  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
}
```

Or better: keep the append-only ledger ONLY and compute balance from `SUM(amount)`. Remove the `Credit` model reference entirely.

---

## 5. Queue Invariants

| Invariant | How to enforce |
|-----------|---------------|
| Job payload minimal | `{ generationId }` only — worker fetches sourceText from DB |
| Idempotent job processing | Status check + atomic lock (see #11) |
| Retries on failure | BullMQ `attempts: 3`, backoff exponential |
| Failed jobs visible | `removeOnFail: { age: 86400, count: 50 }` — already configured |
| No orphaned PROCESSING jobs | Cron job resets stale PROCESSING → QUEUED after timeout |
| Single consumer per job | Only one worker processes each generationId |

**Job payload decision:** `{ generationId: string }` only. The worker looks up `sourceText` from the Generation record. This ensures single source of truth and avoids payload bloat.

---

## 6. Credit Invariants

| Rule | Implementation |
|------|---------------|
| Credit consumed ONLY on success | Debit inside transaction after COMPLETED status |
| Credit balance checked BEFORE generation | `getBalance(userId) >= 1` in controller before creating generation |
| Append-only ledger preserved | Never UPDATE transactions, only CREATE |
| One debit per generation | `CreditTransaction.reference = generationId`, unique constraint |
| Free credits on signup | Transaction: user create + MANUAL_GRANT credit |

**Critical bug:** `CreditsService.consume()` creates a credit transaction WITHOUT checking balance first. If called twice for the same generation, it debits twice. Must check balance before consuming.

**Recommended flow:**
```ts
// In controller, BEFORE creating generation:
const balance = await creditsService.getBalance(userId);
if (balance < 1) throw new Error('INSUFFICIENT_CREDITS');

// In worker, AFTER success:
await prisma.$transaction(async (tx) => {
  await tx.generation.update({ where: { id: generationId }, data: { status: COMPLETED } });
  await tx.creditTransaction.create({ data: { userId, amount: -1, type: GENERATION_DEBIT, reference: generationId } });
  // optional: update Credit balance table if using it
});
```

---

## 7. AI Contract

```typescript
// @slideify/llm
interface LLMProvider {
  generate(sourceText: string): Promise<LLMResponse>;
}

// @slideify/shared
const LLMResponseSchema = z.object({
  slides: z.array(SlideSchema).min(5).max(10),
  meta: z.object({
    slide_count: z.number().int(),
    source_language: z.string().min(2).max(2),
  }),
});

const SlideSchema = z.object({
  order: z.number().int().min(1).max(10),
  title: z.string().min(1).max(60),
  body: z.string().min(1).max(220),
});
```

**Rules:**
- Provider MUST return valid `LLMResponse` or throw
- Validation happens in worker using `LLMResponseSchema.parse()` — Zod, not custom function
- MockProvider is used when `config.llm.mock === true` or no `OPENROUTER_API_KEY`
- OpenRouterProvider uses `response_format: { type: 'json_object' }` for structured output
- No validation in OpenRouterProvider itself — relies on Zod validation in worker

**Recommendation:** Add timeout to OpenRouter fetch (10s) and retry on 429/5xx.

---

## 8. Error Strategy

| Error Type | Handling |
|------------|----------|
| LLM timeout/5xx | BullMQ retry (3 attempts, exponential backoff) |
| LLM invalid response | Mark FAILED, no retry (LLM bug, not transient) |
| Render failure | Mark FAILED, no retry (data issue) |
| Storage failure | Mark FAILED, NO credit debit (storage is outside transaction) |
| Duplicate job (already COMPLETED) | Skip, return success |
| Worker crash | Cron resets PROCESSING → QUEUED after 5 min |
| DB connection lost | BullMQ retry with backoff |

**Key principle:** Only retry transient errors (network, timeout). Never retry semantic errors (invalid LLM response, render failure).

---

## 9. Testing Strategy

| Test Type | Target | Approach |
|-----------|--------|----------|
| Unit | `MockProvider.generate()` | Input → output shape validation |
| Unit | `LLMResponseSchema.parse()` | Valid/invalid payloads |
| Unit | `CreditsService.getBalance()` | Mock Prisma, assert sum |
| Unit | `GenerationController.create()` | Mock service, assert 201 |
| Integration | `POST /generations` → worker → COMPLETED | Test container with Redis + PG |
| Integration | Duplicate request handling | Two requests, one generation |
| Integration | Insufficient credits | Balance=0 → 400 error |
| E2E | Full pipeline | Mock LLM, render, verify DB state |

**No tests needed for:** OpenRouterProvider (integration test with real API), Puppeteer rendering (tested via integration).

---

## 10. Files OpenCode Should Modify

| File | Change |
|------|--------|
| `apps/api/src/generation/generation.service.ts` | Remove LLM/renderer/storage imports. Only create record + enqueue job. |
| `apps/api/src/generation/generation.controller.ts` | Add credit balance check before creating generation. |
| `apps/api/src/generation/generation.module.ts` | Inject BullMQ Queue (from BullMQModule), not create stub. |
| `apps/worker/src/index.ts` | Use `{ generationId }` payload only. Atomic status lock. Move storage into transaction or handle failure. |
| `apps/worker/src/index.ts` | Throw errors for retry, don't catch and return. |
| `apps/api/src/credits/credits.service.ts` | Add `consume(userId, reference)` with balance check. |
| `apps/api/src/auth/auth.service.ts` | Add credit balance check on generation request. |
| `prisma/schema.prisma` | Add unique constraint on `CreditTransaction.reference`. Add `Credit` model OR remove reference from payment controller. |
| `apps/api/src/payment/payment.controller.ts` | Fix `this.prisma.credit` reference — model doesn't exist. |
| `apps/api/src/bullmq/bullmq.module.ts` | Export the Queue instance for injection. |
| `apps/api/src/worker/worker.service.ts` | DELETE this file — duplicate of worker/src/index.ts |
| `packages/shared/src/types.ts` | Add `IdempotencyKey` schema if needed. |

---

## 11. Files OpenCode Should NOT Modify

| File | Reason |
|------|--------|
| `packages/shared/src/types.ts` | Excellent schemas. Don't change unless adding idempotency. |
| `packages/llm/src/providers.ts` | Clean provider implementations. |
| `packages/llm/src/factory.ts` | Good factory pattern. |
| `packages/llm/src/index.ts` | Clean interface. |
| `packages/renderer/src/render.ts` | Working Puppeteer rendering. |
| `packages/renderer/src/storage.ts` | Working storage adapter. |
| `packages/config/src/` | Clean config module. |
| `packages/schema/prisma/schema.prisma` | Good foundation — only ADD, don't restructure. |
| `packages/schema/src/prisma.ts` | Standalone Prisma client, works fine. |
| `apps/api/src/auth/` | Auth is correct. |
| `apps/api/src/main.ts` | Bootstrap is fine. |
| `apps/web/` | Frontend — not in scope for M004. |

---

## 12. Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| **Double credit debit** | CRITICAL | Atomic transaction + unique reference + balance check |
| **Worker crashes mid-processing** | HIGH | Cron resets PROCESSING → QUEUED after timeout |
| **Storage fails after credit debit** | HIGH | Move storage upload INTO transaction, or use outbox pattern |
| **Two workers process same generation** | HIGH | Atomic `updateMany` with status check |
| **BullMQ retries on non-transient errors** | MEDIUM | Only throw for transient errors; return for semantic errors |
| **Payment controller references missing `Credit` model** | HIGH | Fix before M004 — will crash at runtime |
| **GenerationService creates BullMQ queue stub that does nothing** | HIGH | Replace with real queue injection |
| **Duplicate worker implementations** | MEDIUM | Delete `worker.service.ts`, use `worker/src/index.ts` only |
| **Two Prisma clients (NestJS + standalone)** | MEDIUM | Share single PrismaService instance, remove standalone from worker |
| **No idempotency on generation creation** | MEDIUM | Add idempotency key header or unique constraint |
| **Stale PROCESSING jobs** | MEDIUM | Add reconciliation cron |
| **SourceText in job payload is redundant** | LOW | Remove from payload, fetch from DB |
| **Output model never created** | LOW | Add output records in completion transaction |

---

## 13. Critical Bugs Found

### Bug 1: Payment controller crashes
`payment.controller.ts` line 22: `this.prisma.credit.findUnique` — but there is NO `Credit` model in the Prisma schema. Only `CreditTransaction` exists.

### Bug 2: Storage outside transaction
In both `worker/src/index.ts` (lines 96-105) and `worker.service.ts` (lines 68-71), slides are uploaded to storage BEFORE the completion transaction. If storage fails, the credit has already been debited.

### Bug 3: Worker catches errors, BullMQ doesn't retry
`worker/src/index.ts` catches LLM/render errors, sets status to FAILED, and returns. BullMQ sees a successful return → no retry. Transient errors (LLM timeout) should THROW to trigger retry.

### Bug 4: Duplicate worker implementation
`apps/worker/src/index.ts` AND `apps/api/src/worker/worker.service.ts` both process the same queue with the same logic. Only one should exist.

### Bug 5: GenerationService queue stub
`GenerationService.createQueue()` returns a stub object with a no-op `add` method. The BullMQ queue is configured in `bullmq.module.ts` but never injected into the service. Jobs are never actually queued.

### Bug 6: Two Prisma clients
`packages/schema/src/prisma.ts` creates a standalone PrismaClient. `apps/api/src/prisma/prisma.service.ts` creates another. The worker imports from `@slideify/schema` (standalone). This splits connection pools and can exhaust DB connections.

### Bug 7: No balance check before consume
`CreditsService.consume()` creates a GENERATION_DEBIT without checking if the user has credits. Can go negative.

---

## 14. Architecture Decisions for M004

1. **Single worker entry point**: `apps/worker/src/index.ts` only. Delete `worker.service.ts`.
2. **Queue injection**: NestJS `BullMQModule` exports Queue. `GenerationService` injects it.
3. **Minimal job payload**: `{ generationId }` only. Worker fetches `sourceText` from DB.
4. **Atomic completion**: All DB writes (generation status, credit debit, output records, events) in ONE `prisma.$transaction`.
5. **Storage inside transaction**: Upload files first, then transaction. If storage fails, no credit debit. OR: upload after transaction, but track "pending storage" status.
6. **Error classification**: Throw on transient (LLM timeout, network), return on semantic (invalid LLM response). BullMQ retries only on throws.
7. **Credit gate**: Controller checks balance BEFORE creating generation. Worker debits AFTER completion.
8. **Idempotency**: Optional `Idempotency-Key` header on `POST /generations`. If provided, deduplicate.
9. **Reconciliation**: Cron job every 5 min resets `PROCESSING` generations older than 5 min back to `QUEUED`.
10. **Prisma client**: Single instance via NestJS `PrismaService`. Worker uses NestJS bootstrap, not standalone.
