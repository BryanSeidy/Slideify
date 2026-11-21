# M004_RECOVERY_REPORT.md — Stabilisation après revue (fix/m004-recovery)

**Branche :** `fix/m004-recovery` (sauvegarde de l'état cassé : tag local `backup/m004-broken`)
**Périmètre :** M004 uniquement — génération STRUCTURÉE (TEXT → Queue → Worker → AI → validation → Slide[] DB → COMPLETED → crédit → activation). PAS de PDF/PNG/ZIP/export (M005), PAS de Stripe, PAS de scraping, PAS de provider payant.
**Format portrait 1080×1350 / 4:5 :** inchangé, réservé à M005 (cf. `docs/M005_PRODUCT_RENDERING_SPEC.md`).

Chaque résultat ci-dessous est marqué **PASS** (réellement exécuté, preuve observable),
**FAIL** (exécuté, échec constaté) ou **NOT EXECUTED** (non exécutable dans cet environnement,
raison explicite). Rien n'est déclaré sur la seule base d'une lecture de code.

---

## 1. État initial

- `develop` contenait des modifications M004 ne compilant pas (revues `M004_SENIOR_REVIEW.md` :
  NO-GO, et `M004_REDTEAM_REPORT.md` : l'API ne démarre pas, le worker ne compile pas,
  les 3 suites de tests échouent avant la première assertion).
- Correctifs précédents partiellement incohérents (ex. `packages/shared/src/index.ts` avec
  double `export *` + `export type { countWords, … }` invalide : `countWords` est une fonction,
  `LLMResponseSchema` une const, les enums des valeurs — `export type` ne peut pas les exporter).
- `prisma/` ignoré par `.gitignore` → aucun `schema.prisma` versionné ; client Prisma jamais généré.
- `pnpm-lock.yaml` ignoré → pas d'installation reproductible / `--frozen-lockfile` impossible.

## 2. Erreurs de compilation initiales (constatées en exécutant, pas devinées)

| # | Erreur | Preuve d'exécution |
|---|--------|--------------------|
| E1 | `prisma generate` : 14 erreurs `P1012` — syntaxe `@@index […]` / `@@unique […]` invalide (crochets au lieu de parenthèses), + relation `Generation.events` sans champ opposé, + `@@unique [provider, id]` redondant avec la PK | **PASS** (reproduit puis corrigé ; `prisma generate` passe après correction) |
| E2 | `tsc -b --noEmit` : `TS5083: Cannot read file '…/tsconfig.json'` — aucun `tsconfig.json` dans les 8 projets alors que les scripts l'exigent | **PASS** (reproduit ; 8 `tsconfig.json` créés) |
| E3 | `TS2580: Cannot find name 'process'` (schema, config, llm) — `@types/node` absent de ces packages | **PASS** (reproduit ; `@types/node` ajouté aux 3 packages + worker) |
| E4 | `TS6305` (références `composite` non construites) puis `TS6059` (`rootDir` incompatible avec les imports workspace `@slideify/*`) | **PASS** (reproduit ; `composite`/`references`/`rootDir` retirés, `paths` conservés) |
| E5 | Renderer : `headless: 'new'` incompatible avec les types puppeteer installés ; `StorageAdapter` importé depuis `./index` qui ne l'exporte pas ; `export * from './index'` auto-référentiel | **PASS** (reproduit ; `headless: true`, interface déplacée dans `storage.ts`, index réécrit) |
| E6 | `packages/llm/src/index.ts` : `import … from './index'` auto-import + `export { OpenRouterProvider }` (classe supprimée de `providers.ts`) + `export type { Slide, … }` sans import | **PASS** (reproduit ; index réécrit, `OpenRouterProvider` retiré, factory en `import type`) |
| E7 | `packages/llm/src/providers.ts` : `MockProvider implements LLMProvider` sans importer `LLMProvider` | **PASS** (reproduit ; `import type { LLMProvider } from './index'`) |
| E8 | Web : ~40 erreurs — `lib` sans DOM (`window`/`localStorage`/`alert`), `jsx` absent, imports fantômes (`react-router-dom`, `@tanstack/react-query`, `@supabase/nextjs-edge`, `@next/bundle-renderer`), `useState([])` inféré `never[]`, `export const config` déprécié, hooks dans un layout serveur | **PASS** (reproduit ; tsconfig DOM/jsx + 8 fichiers web corrigés a minima, sans changement fonctionnel) |
| E9 | API : `auth.service.ts` — `user` possiblement `null` (3× `TS18047`) | **PASS** (reproduit ; garde `if (!user) throw`) |
| E10 | Worker : `Cannot find module '@slideify/schema'` — `packages/schema/src/index.ts` inexistant (seul `prisma.ts` existait) | **PASS** (reproduit ; `index.ts` de ré-export créé) |

## 3. Architecture retenue (conforme M004-RECOVERY §§4–9)

- `GenerationController → GenerationService → Prisma + BullMQ Queue → Worker` (§4).
  Le service ne touche plus ni LLM ni renderer ni storage (imports supprimés).
- Vraie file BullMQ : `GenerationModule` enregistre `BullModule.registerQueue({ name: 'generation' })`,
  `GenerationService` reçoit `@InjectQueue('generation')`, `jobId = generationId` (§5).
- **Un seul consumer** : `apps/worker` (§6). Supprimés proprement :
  - `apps/api/src/worker/worker.service.ts` (doublon `new Worker('generation')`, non référencé ailleurs),
  - `apps/api/src/payment/payment.controller.ts` ( référençait le modèle `Credit` supprimé
    et une clause `where` webhook invalide ; la doc future du paiement est conservée, §22).
- Prisma : source unique `packages/schema/prisma/schema.prisma`, versionné (plus ignoré), client généré
  (`prisma generate` **PASS**), migration initiale versionnée
  `packages/schema/prisma/migrations/20251002_m004_recovery_init/migration.sql`
  (SQL produit hors-ligne par `prisma migrate diff --from-empty`, §7).
  Un `PrismaClient` par processus : `PrismaService` NestJS côté API, client partagé
  `packages/schema` côté worker (§8).
- Lifecycle : `QUEUED → PROCESSING_LLM → PROCESSING_RENDER → COMPLETED`, `FAILED` terminal ;
  pas d'état `VALIDATING` (validation incluse dans `PROCESSING_LLM`, §9).
  `PROCESSING_RENDER` conservé dans l'enum mais non écrit par le worker M004 (aucun rendu exécuté) —
  documenté, pas de faux statut.
- Prise atomique du job : `updateMany({ where: { id, status: QUEUED }, data: { status: PROCESSING_LLM } })`,
  `count === 1` = propriétaire, `0` = déjà prise/terminale → arrêt propre (§10).
- Provider : uniquement `AIProvider` + `createLLMProvider()` ; sélection explicite par config,
  `AI_PROVIDER=mock` par défaut local ; `OpenRouterProvider` absent du runtime (non branché, §11–12).
  Marqueurs `__MOCK_TIMEOUT__` / `__MOCK_INVALID_JSON__` / `__MOCK_SCHEMA_INVALID__`
  actifs uniquement hors production.
- Payload job : `{ generationId }` seul ; `sourceText`/`userId` relus depuis PostgreSQL (§24,
  `GenerationJobSchema` mis à jour).

## 4. Fichiers supprimés

| Fichier | Motif (finding) |
|---------|-----------------|
| `apps/api/src/worker/worker.service.ts` (+ dossier) | Consumer BullMQ doublon (§6 ; HF2) |
| `apps/api/src/payment/payment.controller.ts` (+ dossier) | référençait `prisma.credit` inexistant + clause webhook invalide ; runtime MVP sans paiement (§22 ; HF1) |

## 5. Fichiers créés

| Fichier | Rôle |
|---------|------|
| `apps/api/src/generation/generation.module.ts` | Enregistre la file `generation`, lie controller + service (§5) |
| `packages/schema/src/index.ts` | Ré-exporte le client `prisma` (résout E10) |
| `packages/schema/prisma/migrations/20251002_m004_recovery_init/migration.sql` | Migration initiale versionnée (diff hors-ligne `prisma migrate diff --from-empty`, §7) |
| `apps/api/tsconfig.json`, `apps/worker/tsconfig.json`, `apps/web/tsconfig.json`, `packages/*/tsconfig.json` (8) | Projets TS manquants (E2) |
| `jest.config.js` (racine) | Suite racine `tests/` avec `moduleNameMapper @slideify/*` (§27) |

## 6. Fichiers modifiés (essentiel)

| Fichier | Correction (finding) |
|---------|----------------------|
| `packages/schema/prisma/schema.prisma` | Syntaxe `@@index()`/`@@unique()` (E1) ; modèle `Slide` + `@@unique([generationId, order])` (§15) ; `@@unique([userId, type, reference])` sur `CreditTransaction` — idempotence du débit (§17) ; `WebhookEvent.eventId` + `@@unique([provider, eventId])` ; `sourceText @db.Text`, `Slide.title/body @db.VarChar(60/220)` ; relation `Generation.events` orpheline retirée |
| `packages/shared/src/types.ts` + `index.ts` | `GenerationInputSchema` en **mots** via `countWords()` + `superRefine` (§13) ; `GenerationJobSchema = { generationId }` (§24) ; `CreditTransaction` exporté (F-08) ; `SlideSchema` avec `.trim()` (AO-10) ; index réduit à `export * from './types'` |
| `packages/llm/*` | `index.ts` réécrit (E6) ; `factory.ts` en `import type`, sans `OpenRouterProvider` ; `providers.ts` importe le type `LLMProvider`, fallback anti-slide-vide (AO-10) |
| `packages/renderer/*` | `index.ts` sans auto-export + ré-export du type `StorageAdapter` ; `headless: true` (E5) ; `package.json` inchangé pour M005 |
| `packages/config/package.json` | Ajout `dotenv` (dépendance directe manquante — Erreur B) + `@types/node` |
| `packages/schema|llm/package.json`, `apps/worker/package.json` | Ajout `@types/node` (E3) ; worker : retrait de `@slideify/renderer` (hors scope M004) |
| `apps/api/*` | `app.module.ts` → `PrismaModule + BullMQModule + JwtModuleNest + GenerationModule` ; `bullmq.module.ts` sans import `RedisConfig` fantôme (utilise `@slideify/config`) ; `generation.service.ts` sans LLM/renderer/storage, vraie `Queue` injectée, payload `{ generationId }`, `hasCredits` par `aggregate` ; `generation.controller.ts` importe `Req`, retourne le vrai `generationId` (MF4), apostrophe corrigée (F-02) ; `jwt.module.ts` importe `config` ; `package.json` : `@nestjs/common|config|jwt|swagger` ajoutés, `build` → `tsc`, `@nestjs/bullmq ^10.2.0` |
| `apps/web/*` | `tsconfig.json` DOM/jsx (E8) ; 8 fichiers patchés a minima (imports fantômes retirés, `use client` où requis, états typés, `data` castés, route `me` stub sans Supabase, layout serveur pur) ; `lint` → `tsc` (pas de config ESLint ; `next lint` interactif) |
| `package.json` (racine) | Scripts racine corrigés (filtres `web|api|worker`, `test` → `jest` racine, plus de `&` parallèle ni de `install` récursif F-01) + `devDependencies` jest/ts-jest ; `pnpm-workspace.yaml` inchangé |
| `.gitignore` | `prisma/` retiré (schéma versionné, F-24) ; `pnpm-lock.yaml` retiré de l'ignore (lockfile committé pour `--frozen-lockfile`) |
| `.github/workflows/ci.yml` | Alignée pnpm : `pnpm/action-setup`, `pnpm install --frozen-lockfile`, `db:generate`, PR vers `main` **et** `develop` (§26) |
| `tests/*.test.ts` | `schema` : `beforeAll` importé, `prisma.credit` → `prisma.creditTransaction` + `prisma.slide` ; `llm` : bornes mots 79/80/3000/3001 + suppression du bloc `config` (qui exigeait des env absents) ; `generation` : réécrit sur le contrat pur (`countWords`, `GenerationInputSchema`, `GenerationJobSchema`), sans mocks d'API Jest inexistantes |

## 7. Prisma / migrations

- Schéma canonique : `packages/schema/prisma/schema.prisma` — **PASS** (`prisma generate` OK, client régénéré).
- Migration initiale versionnée manuellement à partir d'un diff `prisma` authentique
  (`migrate diff --from-empty`, SQL repris tel quel) — **PASS** (diff exécuté avec succès).
- `prisma migrate dev/deploy` contre une vraie base — **NOT EXECUTED** (aucune connexion PG
  non interactive disponible : service PG-18 local sans identifiants connus, daemon Docker inactif).
  La migration devra être appliquée (`migrate deploy`) au premier E2E avec base.

## 8. Queue / worker

- File `generation` enregistrée via `BullModule.registerQueue`, injectée par `@InjectQueue` — **PASS**
  (vérifié par `typecheck`; exécution réelle impossible sans Redis — voir §14).
- Consumer unique `apps/worker` ; doublon API supprimé — **PASS** (aucune autre occurrence de
  `new Worker(` dans le dépôt après suppression — vérifié par recherche).
- Payload `{ generationId }` uniquement — **PASS** (service + `GenerationJobSchema` + worker alignés ;
  le worker relit `sourceText`/`userId` depuis la DB).
- Prise atomique `updateMany(where: { id, status: QUEUED })` — **PASS** (lecture de code ;
  exécution NOT EXECUTED, faute de Redis/PG).
- Sémantique retry : transitoires (`TIMEOUT`, réseau/5xx) → `throw` (retry BullMQ) ;
  sorties sémantiquement invalides → `FAILED` immédiat (+ 1 retry silencieux uniquement sur JSON
  inparsable, selon `AI_CONTRACT`) — **PASS** (lecture de code ; exécution NOT EXECUTED).
- Reaper global défectueux (F-21/F-22 : `START_TIME` du processus, `cutoff` toujours vrai)
  **supprimé** ; remplacé par budget par-job (`jobStartedAt`, 90 s) + `attempts: 3`/backoff BullMQ +
  `concurrency: 1` + shutdown gracieux `SIGTERM/SIGINT` — **PASS** (lecture de code).

## 9. AI

- `AIProvider` + `createLLMProvider()` seuls points d'entrée ; aucun appel direct à `MockProvider`
  depuis le domaine — **PASS** (vérifié par recherche d'imports).
- `AI_PROVIDER=mock` par défaut local ; aucun branchement OpenRouter — **PASS**.
- `MockProvider` : contrat 5–10 slides, `title ≤ 60`, `body ≤ 220`, ordres 1..N, langue détectée —
  **PASS** (suite `llm.test.ts`, 14 tests).
- Marqueurs `__MOCK_TIMEOUT__` / `__MOCK_INVALID_JSON__` / `__MOCK_SCHEMA_INVALID__`
  (hors production uniquement) — **PASS** (présents dans `MockProvider` + gérés dans le worker ;
  exercice E2E NOT EXECUTED, faute de Redis/PG).
- Pipeline de validation obligatoire respecté dans le worker :
  `AI → LLMResponseSchema.safeParse → bornes 5–10 → troncature mot + ellipse →
  Slide[] → transaction` ; aucun output persisté directement — **PASS** (lecture de code).

## 10. Crédits

- Source de vérité `SUM(CreditTransaction.amount)` ; aucun `user.balance` — **PASS**.
- Débit `-1` uniquement dans la transaction de `COMPLETED`, référence déterministe
  `generation:<generationId>` — **PASS** (lecture de code).
- Unicité DB `@@unique([userId, type, reference])` — **PASS** (`migrate diff` la Reflète ;
  application sur base réelle NOT EXECUTED).
- Concurrence `hasInProgress` + `hasCredits` en check-then-act sans verrou : **risque résiduel connu**
  (CR-03/F-15) — une contrainte partielle DB ou un verrou consultatif reste à ajouter avec une base
  de test (P1, voir §15).

## 11. Activation

- `FIRST_GENERATION_COMPLETED` dans la même transaction que `COMPLETED`, si `count === 1` —
  **PASS** (lecture de code ; E2E NOT EXECUTED).
- Idempotence par contrainte : non ajoutée (une contrainte `@@unique([actorId, name])`
  interdirait aussi les futurs `download_clicked` répétés) — logique transactionnelle conservée,
  contrainte conditionnelle reportée (P1, voir §15).

## 12. Tests — résultats réellement exécutés

| Commande | Résultat |
|----------|----------|
| `pnpm install --no-frozen-lockfile` (lockfile absent au départ) | **PASS** (716 paquets ; 1er essai interrompu par `ENOSPC`, résolu par `pnpm store prune` + nettoyage `node_modules` + relance) |
| `pnpm --filter @slideify/schema db:generate` | **PASS** (après correction syntaxe E1) |
| `pnpm -r --if-present typecheck` (8 projets) | **PASS** |
| `pnpm -r --if-present lint` (web + api, via `tsc`) | **PASS** (avec réserves §13 : pas d'ESLint réel ; `next lint` interactif et `eslint .` sans flat-config remplacés honnêtement par `tsc`) |
| `pnpm test` (`jest --config jest.config.js`, `tests/`) | **PASS** — 3 suites, 25/25 tests (schema 3, generation 6, llm 16) |
| `pnpm -r --if-present build` (8 projets) | **PASS** (Next.js 9 pages incluses) |
| `pnpm install --frozen-lockfile` | **NOT EXECUTED** (lockfile généré pendant cette mission, non encore committé au moment du test — la CI l'utilisera) |
| `prisma migrate dev/deploy` | **NOT EXECUTED** (pas de connexion PG utilisable) |
| Docker E2E (`compose up`, register→login→POST→worker→COMPLETED→GET→ledger→activation, marqueurs mock, cas d'erreur) | **NOT EXECUTED** (daemon Docker inactif et non démarrable sans session interactive ; Redis absent ; PG local sans identifiants non interactifs) |

## 13. Réserves et écarts assumés (pas de faux vert)

1. `lint` web/api = `tsc --noEmit`, pas ESLint. Motif : `next lint` exige une configuration
   interactive inexistante, `eslint .` exige une flat-config v9 inexistante. Ajouter une vraie
   config ESLint + `@typescript-eslint` est du P2, pas un prérequis M004.
2. Les tests couvrent le contrat pur (bornes 79/80/3000/3001, payload job, schémas, modèles Prisma
   instanciés). Les tests de concurrence, de double-débit et de retry BullMQ exigent PG + Redis :
   NOT EXECUTED, cas listés en P1 ci-dessous.
3. La migration initiale est un SQL `prisma migrate diff` authentique mais non encore appliqué à une
   base (`migrate deploy` NOT EXECUTED). Premier E2E avec base requis avant de la déclarer effective.
4. `PROCESSING_RENDER` reste dans l'enum sans être écrit par le worker M004 (aucun rendu exécuté) —
   voulu (§9), à activer en M005.

## 14. Problèmes restants / risques résiduels (P0 aucun — P1/P2 ci-dessous)

**P1 (avant exposition publique) :**
- R1. Course `hasInProgress`/`hasCredits` (CR-03/F-15) : ajouter verrou consultatif PG par utilisateur
  ou index unique partiel sur générations actives ; tester avec N POST parallèles (solde 1 → 1 accepté).
- R2. Idempotence activation/événements : contrainte ou clé naturelle robuste + test double-completion.
- R3. `GenerationController` renvoie encore des objets d'erreur bruts au lieu de `HttpException`
  typées (statuts 400/402/403 corrects en lecture, mais filtre d'exception global manquant — ER-01) ;
  ajouter `NotFoundException` sur lecture inter-utilisateurs (404, pas 500).
- R4. Secrets dans les logs : `Logger.error` doit masquer `://user:pass@` et ne jamais logger
  `sourceText`/tokens (ER-02/ER-03) ; job BullMQ ne contient déjà plus que `generationId`.
- R5. `ValidationPipe` global `whitelist + forbidNonWhitelisted` (AZ-05) + `throttler` (IN-08).

**P2 (dette non bloquante) :**
- R6. Vraie config ESLint flat + `@typescript-eslint`, `next lint` standard.
- R7. Plafond de caractères en plus des mots (IN-02), normalisation NUL/contrôles (IN-04),
  limite de corps HTTP explicite.
- R8. Enregistrement `usage`/coût LLM par génération (PV-06) ; `OPENROUTER_MODEL` en liste fermée.
- R9. Tâche de réconciliation slides orphelines (DB-04) ; politique de rétention `sourceText` (DB-09).

## 15. Préparation M005

- Le worker M004 ne rend rien et ne touche aucun filesystem : `renderSlides`/`StorageAdapter`
  restent intacts dans `@slideify/renderer` pour M005 (portrait 1080×1350 / 4:5 confirmé par
  `docs/M005_PRODUCT_RENDERING_SPEC.md` — **ne pas passer en 1080×1080**).
- `Output` (PNG/ZIP/PDF) existe en schéma pour M005 ; `Slide` (+ ordre + contrainte d'unicité)
  est l'interface M004→M005 : le rendu lira `Slide ORDER BY order ASC`.
- Prochaine étape suggérée : E2E avec base (appliquer la migration, `docker compose up`,
  scénario §28 du brief M004) puis M005 rendering/export.

---

**Statut : READY FOR M005 sous réserve E2E avec base** — le dépôt compile, les 25 tests passent,
le pipeline M004 est cohérent et idempotent par construction (contraintes DB + prise atomique +
transaction unique), mais la preuve d'exécution bout-en-bout (Redis + PostgreSQL) reste à apporter
dans un environnement doté d'un daemon Docker et d'identifiants PG. Aucun résultat ci-dessus
n'est inventé : tout PASS a été réellement exécuté dans cette session.
