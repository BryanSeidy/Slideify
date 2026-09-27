# Audit Report — Slideify MVP

## Executive Summary

The repository is **significantly more developed than the TASKS.md indicates**. The codebase already contains implementations for most P0 features, though with several gaps and critical issues that prevent production readiness.

---

## Phase 1 — Architecture Audit

### 1.1 Monorepo Architecture
| SEVERITY | CRITICAL |
|----------|----------|
| **PROBLEM** | Root package.json scripts use `pnpm` but no `turbo.json` is properly configured for task caching and parallelism |
| **EVIDENCE** | `turbo.json` exists but `package.json` uses `pnpm --filter` instead of Turbo task orchestration |
| **IMPACT** | Poor build performance, no correct dependency ordering, no caching |
| **RECOMMENDATION** | Either: (a) Use Turbo properly with `turbo.json` task definitions, or (b) Replace with npm workspaces commands |

### 1.2 Workspace Dependencies
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Missing dependencies declared in worker package.json - references @slideify/llm, @slideify/renderer, @slideify/config, @slideify/schema but these are not declared as dependencies |
| **EVIDENCE** | apps/worker/package.json only has bullmq, ioredis, typescript but code imports from @slideify/* packages |
| **IMPACT** | Worker will fail to run, missing type definitions |
| **RECOMMENDATION** | Add workspace dependencies: @slideify/llm, @slideify/renderer, @slideify/config, @slideify/schema, @prisma/client |

### 1.3 Shared vs Duplicate Types
| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | Zod schemas defined in both packages/shared/src/types.ts and imported in tests, but packages/llm/src/index.ts re-exports them via @slideify/shared |
| **EVIDENCE** | packages/shared/src/types.ts contains LLMResponseSchema, SlideSchema, GenerationInputSchema |
| **IMPACT** | Type duplication potential if not carefully maintained |
| **RECOMMENDATION** | Ensure single source of truth in shared package, re-export from there only |

---

## Phase 1bis — Frontend/API Boundaries Audit

### 1.4 Web API Boundaries
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Web Next.js app uses React Router hooks (`useNavigate` from 'react-router-dom') which are incompatible with Next.js App Router |
| **EVIDENCE** | apps/web/src/app/page.tsx imports `useNavigate` from 'react-router-dom', apps/web/src/app/generate/page.tsx same issue |
| **IMPACT** | All navigation in web app will fail |
| **RECOMMENDATION** | Replace with Next.js `useRouter` from 'next/navigation' |

### 1.5 Missing Package Dependencies
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Next.js app missing @tanstack/react-query, react-router-dom (wrong), @slideify/shared |
| **EVIDENCE** | apps/web/src/app/page.tsx imports from @tanstack/react-query, apps/web/package.json doesn't list them |
| **IMPACT** | Build will fail |
| **RECOMMENDATION** | Add missing dependencies |

---

## Phase 2 — Packages Audit

### 2.1 Config Package
| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | `SLIDEIFY_CREDITS_FREE` has default '3' but ENV_VALIDATION in env.ts requires DATABASE_URL to be present (min(1)), which may cause crashes in development |
| **EVIDENCE** | env.ts: `DATABASE_URL: z.string().min(1, 'DATABASE_URL is required')` |
| **IMPACT** | App fails to start locally without DATABASE_URL |
| **RECOMMENDATION** | Make DATABASE_URL optional for development or provide SQLite fallback |

### 2.2 Schema Package - Prisma
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Prima schema defines `Credit` with `balance` as mutable Int, but BUSINESS REQUIREMENT is append-only ledger for credits |
| **EVIDENCE** | Credit model has `balance Int @default(3)` and allows increment/decrement via Prisma's `increment/decrement` operators |
| **IMPACT** | Impossible to audit credit history, violate acceptance criteria "CreditTransaction = append-only ledger" |
| **RECOMMENDATION** | Create separate CreditTransaction model as append-only ledger, compute balance from sum of transactions |

### 2.3 Schema Package - Missing Modules
| SEVERITY | CRITICAL |
|----------|----------|
| **PROBLEM** | Missing Prisma module file for NestJS (`prisma.module.ts`) which is imported in app.module.ts |
| **EVIDENCE** | apps/api/src/app.module.ts imports `PrismaModule` from './prisma/prisma.module' but file doesn't exist |
| **IMPACT** | NestJS app won't bootstrap |
| **RECOMMENDATION** | Create prisma.module.ts exporting PrismaService |

---

## Phase 3 — NestJS API Audit

### 3.1 Auth Module
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | AuthService creates users but has circular dependency: imports `@slideify/config` with `config` but defined after the class |
| **EVIDENCE** | auth.service.ts line 40: `const config = require('@slideify/config').config;` at bottom of file |
| **IMPACT** | Runtime error: config may not be defined when needed |
| **RECOMMENDATION** | Import config properly at top, or use lazy import pattern |

### 3.2 Generation Module
| SEVERITY | CRITICAL |
|----------|----------|
| **PROBLEM** | GenerationQueueService has invalid import from `@slideify/config` - imports `config` directly but config is a named export from factory.ts |
| **EVIDENCE** | Line 3: `import { config } from '@slideify/config';` but config.ts exports it from cache after calling buildConfig() |
| **IMPACT** | Configuration not properly loaded |
| **RECOMMENDATION** | Verify config module exports correctly |

### 3.3 Payment Module - Webhook Idempotency
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Webhook idempotency key uses `provider_eventType_id` compound unique, but if same webhook ID comes with different eventType, it would create duplicate |
| **EVIDENCE** | `@unique [provider, eventType, id]` constraint |
| **IMPACT** | Idempotent processing not guaranteed |
| **RECOMMENDATION** | Use just `id` (Stripe event ID) as unique identifier for webhook events |

### 3.4 Worker Service
| SEVERITY | CRITICAL |
|----------|----------|
| **PROBLEM** | apps/worker/src/index.ts imports `GenerationStatus` from `@slideify/shared` but this enum doesn't exist in shared/types.ts |
| **EVIDENCE** | Line 8: `import { GenerationStatus } from '@slideify/shared';` |
| **IMPACT** | Build fails - enum defined in Prisma schema only |
| **RECOMMENDATION** | Move GenerationStatus enum to shared package or import from Prisma client type |

---

## Phase 4 — Worker Audit

### 4.1 BullMQ Job Data Contract
| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | Worker expects `GenerationJob` type from shared package but it's defined there as interface with `generationId` and `sourceText` |
| **EVIDENCE** | apps/worker/src/index.ts line 37: `const { generationId, sourceText }: GenerationJob = job.data;` |
| **IMPACT** | Type safety maintained but need to verify serialization |
| **RECOMMENDATION** | Verified OK but add JSON schema validation for job data |

---

## Phase 5 — Security Audit

### 5.1 Credit Consumption - Credit Card Pattern
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Credit consumption happens AFTER generation complete, which is correct (AC-4 in ACCEPTANCE.md). But there's a race condition: if two workers process same job before credit check, could consume twice |
| **EVIDENCE** | apps/worker/src/index.ts line 92-95: credit update after generation completion |
| **IMPACT** | Potential credit loss if duplicate job processing |
| **RECOMMENDATION** | Add transaction in Prisma or check credit balance before queue job |

### 5.2 MockProvider Security
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | MockProvider generates deterministic output based on word count, could be abused to predict outputs |
| **EVIDENCE** | packages/llm/src/providers.ts uses Math.floor(words.length / 50) for slide count |
| **IMPACT** | Low - MockProvider only used in dev mode |
| **RECOMMENDATION** | Add randomization for more realistic dev testing |

### 5.3 HTML Escaping in Renderer
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | Renderer uses custom `escapeHtml` function but doesn't handle all edge cases (e.g., null bytes, surrogate pairs, Unicode normalization) |
| **EVIDENCE** | packages/renderer/src/render.ts escapeHtml function |
| **IMPACT** | Potential XSS if slide content contains malicious HTML/JS |
| **RECOMMENDATION** | Use a battle-tested library like `he` for HTML escaping |

---

## Phase 6 — Database Design Audit

### 6.1 Missing Events Table
| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | No `events` table defined in Prisma schema to track user activation events (first generation completed) |
| **EVIDENCE** | DECISIONS.md mentions "activation = première génération COMPLETED" but no Events model exists |
| **IMPACT** | Cannot track user activation |
| **RECOMMENDATION** | Add `Event` model with name, actorUserId, metadata, createdAt |

### 6.2 Missing UUID Primary Keys
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | Models use cuid() for IDs, but PRODUCT.md mentions UUID needs for external integrations (Future API) |
| **EVIDENCE** | schema.prisma uses `@default(cuid())` |
| **IMPACT** | Future API integration may require migration |
| **RECOMMENDATION** | Consider adding `uuid` field as unique identifier for API exposure |

---

## Phase 7 — CI/CD Audit

### 7.1 Missing Environment Validation
| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | CI doesn't validate environment variables or run database migrations before tests |
| **EVIDENCE** | .github/workflows/ci.yml doesn't setup DATABASE_URL with valid schema |
| **IMPACT** | Tests may pass locally but fail in CI |
| **RECOMMENDATION** | Add pre-test setup: db:generate, db:push with test schema |

### 7.2 No Staging Environment
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | CI only runs on main/develop pushes, no staging deployment configured |
| **EVIDENCE** | No workflow for staging |
| **IMPACT** | Cannot reliably test production deployment |
| **RECOMMENDATION** | Add staging deployment workflow |

---

## Phase 8 — Divergences: Docs vs Code vs Config

### 8.1 TASKS.md vs Actual Implementation
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | TASKS.md shows all P0 tasks as pending `[ ]` but codebase has extensive implementation |
| **EVIDENCE** | TASKS-006 through TASK-015 are checked incomplete but code exists for auth, generation, LLM, renderer, credits, payment, worker |
| **IMPACT** | Misleading documentation for new developers |
| **RECOMMENDATION** | Update TASKS.md to reflect actual implementation status or remove it |

### 8.2 PRODUCT.md Scope vs Actual
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | PRODUCT.md says MVP includes "texte URL → PDF simple, 1 template" but code only supports raw text input |
| **EVIDENCE** | No URL extraction feature implemented |
| **IMPACT** | Product/market fit may not match user expectations |
| **RECOMMENDATION** | Either implement URL input (P1) or update docs to clarify MVP is text-to-PDF only |

### 8.3 Environment Variables
| SEVERITY | LOW |
|----------|------|
| **PROBLEM** | .env.example has `SLIDEIFY_CREDITS_FREE=3` but DECISIONS.md PRODUCT.md says "3 crédits offerts à l'inscription" |
| **EVIDENCE** | Both agree on 3 free credits |
| **IMPACT** | None - correct |
| **RECOMMENDATION** | Verified OK |

---

## Summary of Critical Issues

1. **Worker package.json missing dependencies** (CRITICAL)
2. **Missing Prisma module for NestJS** (CRITICAL)
3. **Web app using wrong React hooks** (HIGH)
4. **Credit balance mutable instead of append-only ledger** (HIGH)
5. **GenerationStatus enum missing from shared package** (CRITICAL)
6. **No events table for activation tracking** (MEDIUM)
7. **DATABASE_URL required in dev** (MEDIUM)
8. **TASKS.md outdated** (MEDIUM)