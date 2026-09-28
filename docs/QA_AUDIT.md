# QA_AUDIT.md — MVP Red Team (Claude2: QA / Security / Growth)

Scope: code present on `develop` (apps/api, apps/web, worker) + concept/docs audit. No scope expansion.
Legend: MVP = must fix before any public exposure / real LLM key. Future = later.
Not reviewed yet: packages/llm, packages/renderer, packages/config, prisma schema, web pages.

## A. Code-level findings

### CRITICAL

**C1. No real authentication: `userId` comes from the request body on every endpoint (IDOR)**
- Why: anyone can read another user's history (`GET /generations`), spend their credits (`POST /generations`), read their balance (`/auth/me`).
- Repro: `POST /generations {"sourceText":"x","userId":"<any id>"}`.
- Also: `POST /auth/magic-link` creates/returns the `userId` immediately, no email is sent or verified => knowing an email = owning the account; unlimited fake emails = unlimited free credits (LLM cost with zero revenue).
- Fix (MVP): signed session/JWT (one mechanism only, see M3), derive `userId` from the session server-side, verify the magic-link token before issuing a session, never return `userId` from magic-link.
- Acceptance: request without valid session => 401; a user cannot access another user's generation (403/404); free credits granted only after email verification.

**C2. Payment webhook is unauthenticated and not idempotent**
- Why: anyone can POST a fake `checkout.session.completed` with any `userId` and get +20 credits; replays add credits again.
- Repro: `POST /payment/webhook {"id":"e1","type":"checkout.session.completed","data":{"object":{"metadata":{"userId":"<id>"}}}}` twice.
- Root cause: no Stripe signature check (`constructEvent` + raw body); dedupe looks up by `id: eventId` but `create()` never stores that id, so the lookup never matches.
- Fix (MVP, before enabling real payments): verify signature with raw body, store `event.id` as unique key and insert-then-process in one transaction, credit via ledger (see C3).
- Acceptance: unsigned request => 400; same event twice => credited once (test).

**C3. Credits have two sources of truth**
- Why: balance is read from `CreditTransaction` (sum), but the webhook increments `credit.balance` (different table). Purchased credits never appear in `getBalance`; checkout logic (`credits.balance > 0 => ALREADY_HAS_CREDITS`) is inverted/blocks buyers who still have credits and rejects users without a `credit` row.
- Fix (MVP): keep the append-only ledger only; webhook writes a `PURCHASE` transaction with `reference = event.id` (unique). Drop or derive the `credit` table.
- Acceptance: after a paid webhook, `getBalance` increases by the pack size; single source of truth in code.

**C4. The generation is never enqueued**
- Why: `POST /generations` inserts a `QUEUED` row and returns; nothing calls `queue.add(...)`. Nothing ever runs => the core feature does not work end to end.
- Fix (MVP): enqueue with `jobId = generationId` (built-in idempotency), only after the row is committed.
- Acceptance: create => status moves QUEUED -> PROCESSING -> COMPLETED in an integration test with MockProvider.

### HIGH

**H1. Apparent compile/route bugs (CI would fail on typecheck)**
- `generation.controller.ts` imports `./generation/generation.service` (wrong relative path) and `GenerationService` while the file exports `GenerationQueueService`; `auth.controller.ts` has the same wrong-path pattern.
- `@Get(':id/status')` reads `@Body('id')` instead of `@Param('id')` => always `undefined`; GET with body is dropped by many clients/proxies (`/auth/me`, history too). Use `@Param` / session.
- Acceptance: `npm run typecheck` green; status endpoint returns the right record.

**H2. Credit overspend (race) and non-idempotent debit**
- Balance is checked at creation but debited only at completion: N parallel requests with 1 credit all pass => N paid LLM calls. Debit has no uniqueness on `reference`, so a job re-run debits twice.
- Fix (MVP, simple): reserve/debit at creation inside a transaction (refund on FAILED), or count in-flight jobs against balance; add unique `(type, reference)`; skip processing if generation already COMPLETED.
- Acceptance: 5 parallel requests with 1 credit => 1 accepted; re-running a job never double-debits.

**H3. Errors are swallowed => no retries, jobs stuck**
- The worker catches everything and returns, so BullMQ never retries (`attempts: 3` is dead config) and a crash/DB error leaves the generation in `PROCESSING_LLM` forever (UI polls endlessly). LLM errors are marked FAILED immediately, even for transient 429/5xx.
- Fix (MVP): throw retryable errors (429/5xx/timeout), mark FAILED only in the `failed` handler after the last attempt (or non-retryable errors); add a job timeout.
- Acceptance: transient LLM error => 3 attempts then FAILED with a user-facing message; no generation stays PROCESSING beyond the timeout.

**H4. No input validation, limits or rate limiting**
- No `ValidationPipe`/DTO, no max length on `sourceText`, no throttling, no `helmet`. Cost/abuse exposure (LLM tokens, Puppeteer CPU).
- Fix (MVP, free): global `ValidationPipe` with DTOs, `sourceText` max ~15k chars, `@nestjs/throttler`, per-user daily cap.
- Acceptance: oversized input => 400 before any queue/LLM call; burst => 429.

**H5. LLM output only checked for slide count**
- `validateLLMResponse` checks 5-10 slides but not fields, types or lengths; content goes straight to the renderer. Risk: broken/empty PDFs, HTML injection into templates, prompt-injection effects.
- Fix (MVP): Zod schema (title/body max lengths), HTML-escape everything in templates, one retry on invalid JSON. (Renderer not reviewed yet — verify escaping there.)
- Acceptance: invalid/oversized/HTML-containing slide never reaches Puppeteer unescaped.

### MEDIUM

- **M1. Duplicate worker implementations**: `GenerationQueueService` and `WorkerService` (both in API) and `apps/worker/src/index.ts` duplicate the same pipeline and validation; risk of drift and double consumption. Keep one (the separate worker), remove the others. MVP (maintenance).
- **M2. Result access control and storage**: uploads keyed by `generationId`; confirm outputs are only served to the owner (signed/short-lived URLs) and define retention (TTL). MVP for ownership check, Future for TTL/cloud.
- **M3. Two auth systems**: API has its own magic-link, the web route uses a Supabase client (package name `@supabase/nextjs-edge` looks wrong) while `.env.example` has `AUTH_SECRET`. Pick one. MVP.
- **M4. CI does not run on PRs to `develop`** (only PRs to `main`), while the workflow says PRs target `develop`. Add `develop` to `pull_request.branches`. MVP (cheap).
- **M5. `authenticateWithMagicLink` returns the last MANUAL_GRANT amount as `credits`** instead of the summed balance. Wrong display, low effort fix. MVP.
- **M6. Cost tracking**: `tokens_used` / `estimated_cost` are not recorded per generation, so cost per generation cannot be measured. MVP (2 columns).
- **M7. History endpoint has no pagination** and includes all outputs. MVP light (limit 20).

### LOW

- `main.ts` hardcodes port 3001 (use env). `.gitignore` typos (`*.8 coverage/`, `.tumi/` -> `.turbo/`). Content moderation and licence: Future.

## B. Concept-level findings (first audit, still valid)
SSRF on URL extraction (CRITICAL, MVP, TASK-010); prompt injection (MVP); HTML sanitization (MVP); input size (MVP); retry policy (MVP); progress polling UX (MVP light); moderation (Future); file retention (Future).

## C. Secret hygiene (done)
`GITHUB_Tok.txt` verified untracked and absent from all branch histories; ignore patterns added (PR chore/ignore-secret-notes); secret scanning + push protection enabled. Tokens must be revoked at the end of the mission and never committed.

## D. Suggested fix order (smallest path to a safe MVP)
1. C1 + M3 (one real auth) -> 2. C4 + H1 (pipeline actually runs) -> 3. C3 + H2 (single credit ledger, atomic debit) -> 4. H3 + H4 + H5 (reliability and limits) -> 5. C2 before enabling real Stripe -> 6. M4/M5/M6.
