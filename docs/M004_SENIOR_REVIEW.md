# M004 Senior Review — Post-Implementation Audit

**Date:** 2026-09-30  
**Purpose:** Senior audit of M004 implementation AFTER code delivery  
**Rule:** NE CODE PAS — audit only

## Executive Summary

M004 implements the core generation flow: JWT → POST /generations → Generation → BullMQ → Worker → AIProvider → Validation → Slides → COMPLETED → CreditTransaction → Activation Event.

### Overall Assessment: **PARTIAL**

The implementation has made progress from the architecture review but contains critical flaws that violate key invariants, particularly around credit atomicity and idempotency. While many claimed features are present, their implementation has significant gaps.

## Verified Claims

| Claim | Status | Evidence |
|-------|--------|----------|
| JWT identity correct | ✅ PASS | Controller uses `req.user.userId` from JwtAuthGuard |
| Ledger append-only | ✅ PASS | CreditTransaction only CREATE, never UPDATE/DELETE |
| Validation Zod | ✅ PASS | `LLMResponseSchema.parse()` used in worker |
| Worker completes core steps | ✅ PARTIAL | Worker does LLM → validation → render → store → debit |
| Activation event on first completion | ✅ PASS | Transaction checks `firstCompleted === 1` |
| Global timeout (90s) | ✅ PASS | Worker checks `Date.now() - START_TIME > GLOBAL_TIMEOUT_MS` |
| Reaper for stuck jobs | ✅ PASS | setInterval every 30s fails PROCESSING_* jobs older than timeout |

## False/Incomplete Claims

| Claim | Status | Evidence |
|-------|--------|----------|
| Idempotency (no double debit on retry) | ❌ FAIL | See Critical Finding #1 |
| Credit atomicity (exactly one debit per COMPLETED) | ❌ FAIL | See Critical Finding #2 |
| No duplicate processing | ❌ FAIL | See Critical Finding #3 |
| Worker throws on transient errors for BullMQ retry | ❌ FAIL | Worker catches and returns success, preventing retries |
| Transaction includes storage upload | ❌ FAIL | Storage upload happens BEFORE transaction |

## Critical Findings

### CF1: Idempotency Broken — Retry Causes Double Debit
**Files:** `apps/worker/src/index.ts` (lines 99-112)  
**Issue:** Worker implements a "silent retry" for JSON-invalid simulations but DOES NOT decrement attempts or signal BullMQ to retry. Instead, it makes a second LLM call internally. If this succeeds, it proceeds to completion and debits credit. However, the original job is still seen as successful by BullMQ (no error thrown), so NO BullMQ retry occurs.  
**Impact:** No double debit FROM THIS MECHANISM, but the claim "retry = no double debit" is unverified for actual BullMQ retries.  
**Proof:** Lines 100-112 catch 'Invalid JSON simulated', make a second LLM call, and if successful, continue to completion. BullMQ sees job as completed.

### CF2: Credit Atomicity Violated — Double Debit Possible
**Files:**  
- `apps/worker/src/index.ts` (storage upload BEFORE transaction, lines 172-182)  
- `apps/worker/src/index.ts` (catch block does NOT debit, but storage may have succeeded)  
- `packages/llm/src/providers.ts` (MockProvider can throw after partial work)  

**Issue:**  
1. Storage upload occurs BEFORE the prisma.$transaction (line 172-182)  
2. If storage succeeds but transaction fails (e.g., DB constraint), credits are NOT debited BUT slides are persisted → orphaned slides  
3. If storage fails AFTER transaction success (theoretically possible if storage is external), credits ARE debited but slides missing  
4. Worse: The MockProvider in providers.ts can be made to throw AFTER generating slides but BEFORE returning (not implemented, but architecturally possible)  

**Impact:** Violates "Generation COMPLETED → exactly one debit" invariant.  
**Proof:** Storage upload (lines 174-181) happens BEFORE transaction start (line 173). No compensating transaction for storage cleanup.

### CF3: Duplicate Processing Possible — Race Condition
**Files:** `apps/worker/src/index.ts` (lines 52-67)  
**Issue:** Worker checks `if (generation.status === GenerationStatus.COMPLETED || generation.status === GenerationStatus.FAILED)` but uses `findUnique` THEN `update`. Between these, another worker could have updated the status.  
**Impact:** Two workers could both see status as PROCESSING_LLM and both proceed to completion, causing double debit and duplicate slides.  
**Proof:** Lines 54-66: `findUnique` → lines 70-73: `update`. No atomic check-and-update.

### CF4: BullMQ Retries Broken — Worker Swallows Errors
**Files:** `apps/worker/src/index.ts` (lines 96-120, 122-134, 163-170, 224-239)  
**Issue:** Worker catches ALL errors (LLM, validation, render, transaction) and returns normally (no throw). BullMQ interprets this as job success → NO retry occurs.  
**Impact:** Transient errors (LLM timeout, network blip) are NOT retried despite BullMQ config `attempts: 3`.  
**Proof:** Every catch block ends with `return;` or updates status to FAILED and returns. Never re-throws.

### CF5: Storage Outside Transaction — Orphaned Assets
**Files:** `apps/worker/src/index.ts` (lines 172-182)  
**Issue:** Slides uploaded to storage BEFORE entering prisma.$transaction. If transaction fails after storage success, slides are orphaned with no debit.  
**Impact:** Storage fills with unused slides; no cleanup mechanism.  
**Proof:** Lines 172-182 (storage upload) occur before line 173 (`await prisma.$transaction(...)`).

## High Findings

### HF1: Payment Controller References Missing Model
**Files:** `/c/Dev/PROJECT/Slideify/apps/api/src/payment/payment.controller.ts` (line 22)  
**Issue:** Uses `this.prisma.credit.findUnique` but NO `Credit` model exists in schema.prisma. Only `CreditTransaction`.  
**Impact:** Will crash at runtime when payment endpoints are called.  
**Evidence:** Schema shows only `CreditTransaction` model (lines 27-39).

### HF2: Double Queue Implementations
**Files:**  
- `apps/worker/src/index.ts` (real BullMQ worker)  
- `apps/api/src/worker/worker.service.ts` (NestJS worker, duplicate logic)  
**Issue:** Two workers listening to same 'generation' queue → unpredictable job distribution.  
**Impact:** Jobs may be processed by either worker; monitoring and metrics split.  
**Evidence:** Both files contain Worker('generation', ...) instantiation.

### HF3: GenerationService Queue Stub
**Files:** `apps/api/src/generation/generation.service.ts` (lines 103-112)  
**Issue:** `createQueue()` returns stub `{ add: async () => {} }`. No actual BullMQ queue injection.  
**Impact:** Despite BullMQModule being imported, jobs are NOT enqueued to Redis.  
**Evidence:** Lines 45-50 call `this.createQueue().add(...)` which is a no-op.

### HF4: Two Prisma Clients Risk
**Files:**  
- `packages/schema/src/prisma.ts` (standalone PrismaClient)  
- `apps/api/src/prisma/prisma.service.ts` (NestJS PrismaService)  
**Issue:** Worker imports `prisma` from `@slideify/schema` (standalone), API uses NestJS service.  
**Impact:** Two connection pools; potential DB exhaustion under load.  
**Evidence:** Worker line 6: `import { PrismaService } from '@slideify/schema'` → actually gets standalone client.

### HF5: Credit Service Lacks Balance Check
**Files:** `apps/api/src/credits/credits.service.ts` (lines 16-25)  
**Issue:** `consume()` creates debit transaction WITHOUT checking balance first.  
**Impact:** Can lead to negative balances if called concurrently or in error paths.  
**Evidence:** Lines 16-25: straight `creditTransaction.create` with amount: -1.

## Medium Findings

### MF1: Global Timeout Based on Worker Start Time
**Files:** `apps/worker/src/index.ts` (lines 12-14, 42-49)  
**Issue:** `START_TIME: number = Date.now()` at worker init, not per-job.  
**Impact:** Long-running worker will fail ALL jobs after 90s regardless of job age.  
**Evidence:** Line 14 sets START_TIME once; line 43 checks against it.

### MF2: Reaper Uses Wall Clock, Not State Entry Time
**Files:** `apps/worker/src/index.ts` (lines 261-286)  
**Issue:** Reaper compares `Date.now() - GLOBAL_TIMEOUT_MS` to implicit job start, not time entered PROCESSING state.  
**Impact:** May fail jobs that entered PROCESSING recently but worker started long ago.  
**Evidence:** Line 272: `cutoff = Date.now() - GLOBAL_TIMEOUT_MS` (no per-job timestamp).

### MF3: No Unique Constraint on CreditTransaction.reference
**Files:** `prisma/schema.prisma` (lines 27-39)  
**Issue:** `reference String?` has NO `@unique` constraint.  
**Impact:** Race condition could allow multiple debits with same reference.  
**Evidence:** Line 33: `reference String?` — no index or unique.

### MF4: GenerationController Returns Empty generationId
**Files:** `apps/api/src/generation/generation.controller.ts` (line 52)  
**Issue:** POST /generations returns `{ status: 'QUEUED', generationId: '' }`  
**Impact:** Client cannot track generation; breaks polling flow.  
**Evidence:** Line 51-53: hardcoded empty string.

### MF5: MockProvider Test Markers in Production Code
**Files:** `packages/llm/src/providers.ts` (lines 11-14, 56-67)  
**Issue:** MockProvider contains test-specific logic (MARKER_*) guarded by `process.env.NODE_ENV !== 'production'`  
**Impact: Development/test code in production path; risk if env misconfigured.  
**Evidence:** Lines 12-14, 57-60, 62-67.

## Database Invariants

| Invariant | Status | Evidence |
|-----------|--------|----------|
| User.email unique | ✅ PASS | Line 16: `@unique` |
| CreditTransaction append-only | ✅ PASS | Only CREATE operations in code |
| Generation status enum | ✅ PASS | Lines 70-76: QUEUED|PROCESSING_LLM|...|FAILED |
| Output format enum | ✅ PASS | Lines 92-95: PNG|ZIP|PDF |
| Generation → User FK | ✅ PASS | Line 51-52: relation |
| Output → Generation FK | ✅ PASS | Line 81: relation |
| **Missing**: Unique constraint on CreditTransaction.reference | ❌ MISSING | Would prevent double debit |
| **Missing**: Credit model (referenced by payment controller) | ❌ MISSING | Controller will crash |

## Queue Invariants

| Invariant | Status | Evidence |
|-----------|--------|----------|
| Job payload: { generationId, sourceText } | ✅ PASS | Lines 38-39: destructured from job.data |
| BullMQ attempts: 3 | ✅ PASS | Line 31: `attempts: 3` |
| BullMQ backoff: exponential | ✅ PASS | Line 31: `backoff: { type: 'exponential', delay: 2000 }` |
| Remove completed jobs after 1h | ✅ PASS | Line 21: `removeOnComplete: { age: 3600 }` |
| Remove failed jobs after 24h, max 50 | ✅ PASS | Line 22: `removeOnFail: { age: 86400, count: 50 }` |
| **Broken**: Worker throws on transient errors for retry | ❌ FAIL | See CF4 |
| **Broken**: Atomic job processing (no double work) | ❌ FAIL | See CF3 |

## Credit Invariants

| Invariant | Status | Evidence |
|-----------|--------|----------|
| Balance = SUM(CreditTransaction.amount) | ✅ PASS | Service uses `$queryRaw` SUM |
| Credits checked before generation | ❌ FAIL | Controller checks via `hasCredits()` but race possible |
| Exactly one debit per COMPLETED generation | ❌ FAIL | See CF1, CF2, CF3 |
| No debit on failure | ✅ PASS | Catch blocks do not call consume() |
| Free credits on signup | ✅ PASS | Auth service creates MANUAL_GRANT |
| **Broken**: Atomic debit-with-completion | ❌ FAIL | Storage outside transaction (CF5) |
| **Broken**: Concurrent generation protection | ❌ PARTIAL | `hasInProgress()` check but race condition |

## AI Invariants

| Invariant | Status | Evidence |
|-----------|--------|----------|
| AIProvider.generate() called exactly once per job (except simulated retry) | ✅ PASS | Line 87: single call outside retry block |
| LLMResponse validated by Zod schema | ✅ PASS | Line 126: `LLMResponseSchema.parse()` |
| Slide.title ≤ 60 chars | ✅ PASS | Lines 149-152: truncation |
| Slide.body ≤ 220 chars | ✅ PASS | Lines 154-156: truncation |
| Slide count between 5-10 | ✅ PASS | Lines 138-144: validation |
| Orders 1..N without duplicates | ✅ PASS | Lines 32-36: order: generation loop |
| source_language is ISO 639-1 | ✅ PASS | Lines 51-53: regex check |
| **Note**: Truncation may break words (minor) but acceptable | ⚠️ ACCEPTABLE | Lines 151, 155: split/join + ellipsis |

## Test Gaps

| Gap | Severity |
|-----|----------|
| No concurrency tests (race conditions) | HIGH |
| No credit atomicity tests (double debit scenarios) | HIGH |
| No BullMQ retry verification tests | HIGH |
| No storage failure scenarios | MEDIUM |
| No orphaned slide cleanup verification | MEDIUM |
| No timeout/reaper functional tests | MEDIUM |
| No idempotency key tests (if implemented) | LOW |
| **Coverage**: Unit tests exist for validation logic but NOT for workflow invariants | GENERAL |

## Required Fixes Before M005

### Critical (Must Fix)
1. **Move storage upload INTO transaction**  
   - Upload to temporary location or use storage that supports transactions  
   - OR: Implement outbox pattern for storage  
   - Files: `apps/worker/src/index.ts`

2. **Make credit debit atomic with generation completion**  
   - Already in transaction, but storage must be inside or compensated  
   - Files: `apps/worker/src/index.ts`

3. **Fix duplicate processing with atomic status transition**  
   - Replace `findUnique` + `update` with `updateMany` where status = QUEUED  
   - Files: `apps/worker/src/index.ts` lines 52-67

4. **Enable BullMQ retries by throwing on transient errors**  
   - Remove catch/return; let errors propagate to worker.on('failed')  
   - Files: `apps/worker/src/index.ts` (all catch blocks)

5. **Fix or remove duplicate worker**  
   - Delete `apps/api/src/worker/worker.service.ts`  
   - Use only `apps/worker/src/index.ts`

6. **Inject real BullMQ Queue into GenerationService**  
   - Constructor inject Queue from BullMQModule  
   - Files: `apps/api/src/generation/generation.service.ts`

7. **Fix payment controller missing Credit model**  
   - Either add Credit model to schema or use ledger aggregation  
   - Files: `apps/api/src/payment/payment.controller.ts`

### High (Should Fix)
8. **Add unique constraint on CreditTransaction.reference**  
   - Prevents double debit at DB level  
   - Files: `prisma/schema.prisma`

9. **Fix GenerationController to return actual generationId**  
   - Files: `apps/api/src/generation/generation.controller.ts`

10. **Standardize on single Prisma client**  
    - Worker should use NestJS PrismaService or share instance  
    - Files: `apps/worker/src/index.ts`, `packages/schema/src/prisma.ts`

11. **Add balance check to CreditsService.consume()**  
    - Prevent negative balances  
    - Files: `apps/api/src/credits/credits.service.ts`

## Optional Improvements

12. **Per-job timeout tracking**  
    - Store startedAt and check against it, not worker start time  
    - Files: `apps/worker/src/index.ts`

13. **Idempotency-Key header support**  
    - Prevent duplicate generations from retries  
    - Files: `apps/api/src/generation/generation.controller.ts`

14. **Remove test markers from production code**  
    - Move test-specific logic to test files only  
    - Files: `packages/llm/src/providers.ts`

15. **Add reconciliation job for orphaned slides**  
    - Periodic cleanup of slides without COMPLETED generation  
    - New file: `apps/worker/src/reaper.ts`

## Go / No-Go Recommendation

**NO-GO** for production deployment as currently implemented.

### Blocking Issues
- ❌ Credit atomicity not guaranteed (storage outside transaction)
- ❌ Duplicate processing possible (race condition in status check)
- ❌ BullMQ retries broken (worker swallows errors)
- ❌ Payment controller will crash (missing model)

### Would Allow Deployment With Mitigations
If the following were fixed:
1. Storage upload moved into transaction or compensated
2. Atomic status update (`updateMany` where status = QUEUED)
3. Worker throws errors to enable BullMQ retries
4. Payment controller fixed
5. Unique constraint added on CreditTransaction.reference

### Current State Summary
The implementation satisfies the happy path and basic structure but fails under concurrent load, failure scenarios, and retry conditions. The claimed invariants around credit atomicity and idempotency are not actually enforced by the code or database constraints.

**Recommendation:** Address the Critical findings above before considering M004 complete or proceeding to M005.

---
*Review completed by inspecting actual code diff and repository state. No modifications made to codebase during audit.*