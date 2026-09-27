# CLAUDE.md

## Project Overview

Slideify is an AI-powered content repurposing micro-SaaS. It transforms text into structured social-media-ready assets: carousel posts, PDFs, slide images, and publication text.

## Tech Stack

- **Frontend**: Next.js 14, TypeScript, Tailwind CSS
- **Backend**: NestJS, TypeScript
- **Database**: PostgreSQL, Prisma ORM
- **Queue**: BullMQ, Redis
- **Rendering**: Puppeteer, HTML/CSS
- **Auth**: Supabase (magic link)
- **Payments**: Stripe Checkout
- **LLM**: OpenRouter (with MockProvider for dev)

## Architecture

```
User → Next.js → NestJS API → BullMQ → Redis → Worker → LLM/Puppeteer → Storage
```

## Key Decisions

- **ADR-001**: TypeScript-first architecture
- **ADR-002**: Next.js 14 with App Router
- **ADR-003**: NestJS backend with modular pattern
- **ADR-004**: PostgreSQL + Prisma ORM
- **ADR-005**: BullMQ + Redis for async processing
- **ADR-006**: HTML/CSS + Puppeteer for rendering
- **ADR-007**: LLM provider abstraction (MockProvider for dev, OpenRouter for prod)
- **ADR-008**: Zero-budget development strategy (mock services in dev)
- **ADR-009**: Monorepo with Turborepo/Bun

## Development Commands

```bash
npm install
npm run dev        # Start API + Web
npm run worker     # Start BullMQ worker
npm run build      # Build all packages
npm run test       # Run all tests
npm run lint       # Lint all packages
npm run typecheck  # Type-check all packages
npm run db:generate # Generate Prisma client
npm run db:push    # Push schema to database
```

## Testing

- Unit tests: Jest
- Integration tests: API endpoints
- E2E tests: Full generation pipeline

## Security Notes

- Never hardcode secrets — use environment variables
- Validate all user input with Zod schemas
- Use parameterized queries (Prisma handles this)
- Stripe webhooks must be idempotent
- Never expose internal error details to users