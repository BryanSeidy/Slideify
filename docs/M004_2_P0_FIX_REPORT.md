# M004_2_P0_FIX_REPORT.md — Correction des 2 P0 de Claude2 (branche `fix/m004-recovery`)

**Verdict d'entrée (Claude2) :** CONDITIONAL GO — 2 P0 bloquants avant M005.
**Périmètre :** strictement M004. Aucun renderer/export/PDF/PNG, aucun Stripe/scraping,
aucun affaiblissement d'invariant pour faire passer les tests.

Chaque résultat est marqué **PASS** (réellement exécuté), **FAIL** ou **NOT EXECUTED**
(avec la raison). Aucun résultat inventé.

---

## P0 #1 — AUTHENTICATION INACCESSIBLE

### Cause racine
1. `AuthController` (`POST auth/magic-link`, `GET auth/me`) n'était déclaré dans **aucun
   module** : `JwtModuleNest` ne listait aucun `controllers`, `AppModule` ne listait que
   `HealthController`. Les routes n'existaient donc pas à l'exécution.
2. De plus, **aucune route ne délivrait de JWT** : `AuthService.login()` existait mais
   n'était appelé par aucun contrôleur. Même câblé, le flux register/login → JWT
   restait impossible.
3. `JwtModuleNest` dupliquait la configuration JWT hors de tout module fonctionnel.

### Fichiers modifiés
| Fichier | Changement |
|---------|------------|
| `apps/api/src/auth/auth.module.ts` | **Créé** : `PrismaModule` + `JwtModule.register` (secret 7j), `controllers: [AuthController]`, `providers/exports: [AuthService, JwtAuthGuard]` |
| `apps/api/src/auth/auth.controller.ts` | Ajout `POST auth/login` (register-or-login par email → `{ accessToken, userId, email, credits }`) ; `BadRequestException` 400 sur email invalide ; `Req` importé |
| `apps/api/src/auth/jwt.module.ts` | **Supprimé** (doublon sans controller ; raison documentée ici, pas de code perdu : `JwtModule.register` vit désormais dans `AuthModule`) |
| `apps/api/src/app.module.ts` | `JwtModuleNest` → `AuthModule` |
| `apps/api/package.json` | Ajout devDep `@nestjs/testing` (tests de wiring) |

### Solution
- Un seul module auth (`AuthModule`), câblé dans `AppModule` : les routes
  `POST /auth/magic-link`, `POST /auth/login`, `GET /auth/me` sont exposées.
- `POST /auth/login { email }` enchaîne `authenticateWithMagicLink` (création + `+3 MANUAL_GRANT`
  si nouveau) puis `login` (signature JWT `sub/email/credits`, 7 jours).
- Protections conservées : `GET /auth/me` et toutes les routes `generations` lisent
  **uniquement** `req.user` (JWT vérifié) ; aucun `userId` du body n'est utilisé comme identité
  (`AuthController.login` ne reçoit qu'un email, `GenerationController` que `sourceText`).
- Comportement crédits à l'inscription inchangé (D-11 reste un résiduel documenté, hors P0).

### Tests ajoutés (`tests/auth.test.ts`, 9 tests)
- `AuthModule` compile via `Test.createTestingModule` + expose `AuthController` avec ses
  3 handlers (preuve du wiring).
- Nouveau compte → `+3 MANUAL_GRANT signup_bonus` + JWT vérifiable (`sub`/`email`).
- Reconnexion → même compte, **pas** de second grant.
- Email invalide → 400 avant tout accès DB (0 utilisateur créé).
- `getMe` retourne l'identité JWT (jamais un body).
- `JwtAuthGuard` : token valide → `true` + `req.user` ; absent/malformé/forgé → `false`, sans `req.user`.

### Résultats
| Vérification | Résultat |
|--------------|----------|
| `Test.createTestingModule({ imports: [AuthModule] }).compile()` | **PASS** (suite `auth.test.ts`) |
| login → JWT vérifiable → guard OK | **PASS** (9/9 tests auth) |
| Flux HTTP réel register→login→POST→worker→COMPLETED | **NOT EXECUTED** (pas de PG/Redis/Docker utilisable dans cet environnement — voir § Validation) |

---

## P0 #2 — RETRY BULLMQ STRUCTURELLEMENT CASSÉ

### Cause racine
Prise atomique `updateMany({ id, status: QUEUED } → PROCESSING_LLM)` correcte au 1er passage,
mais après une erreur transitoire (throw → retry BullMQ programmé), la génération restait
`PROCESSING_LLM` : le retry retombait sur la branche « déjà prise → skip » et le job était
**acknowledged sans que le LLM ne soit ré-exécuté**. Prouvé par lecture + reproduction
en test (retry simulé → `skip-busy`, 1 seul appel LLM, génération jamais terminée).

### Fichiers modifiés
| Fichier | Changement |
|---------|------------|
| `apps/worker/src/claim.ts` | **Créé** : `acquireForProcessing` (claim QUEUED atomique + reclaim d'un PROCESSING **stale** > 180 s + skip busy/terminal/missing), `resetForRetry` (PROCESSING_LLM → QUEUED conditionnel), `shouldRetry(attemptsMade, max)` (0-based), `isTransientError`, constantes `MAX_ATTEMPTS=3`, `STALE_PROCESSING_MS`, `GENERATION_TIMEOUT_MS` (budget **par tentative**, jamais global) |
| `apps/worker/src/processor.ts` | **Créé** : `processGeneration(db, llm, { generationId, attemptsMade, maxAttempts, budgetMs?, now? })` — tout le pipeline M004 (claim → LLM → Zod → slides → transaction slides+COMPLETED+débit+activation). Transitoire : `resetForRetry` + `throw` (retry réel) ou `FAILED` si tentatives épuisées ; sémantique : `FAILED` immédiat sans throw ; violation d'unicité en commit : succès idempotent |
| `apps/worker/src/index.ts` | Réduit au câblage BullMQ (file, `attempts/maxAttempts` depuis le job, `concurrency: 1`, shutdown gracieux) ; appelle `processGeneration` |
| `apps/worker/package.json` | Ajout `@prisma/client` (typage `PrismaClient` du processeur) |

### Solution — cycle d'état corrigé
- Tentative N < max : erreur transitoire → `resetForRetry` (QUEUED **conditionnel** : si la ligne
  a été terminée entre-temps par un concurrent, pas de reset et pas de retry) → `throw`
  → BullMQ redélivre → `acquireForProcessing` retrouve QUEUED → **ré-exécution réelle**.
- Dernière tentative : écriture `FAILED` (code `TIMEOUT`/`LLM_ERROR`/`TRANSACTION_ERROR`) + retour
  normal (plus de retry).
- Crash sans reset (état PROCESSING orphelin) : reclaim autorisé uniquement si `startedAt`
  > 180 s (BullMQ ne redélivre qu'après perte du lock : l'ancien propriétaire est mort).
  Un PROCESSING frais reste `skip-busy` (single-consumer préservé).
- Garantie single-consumer inchangée : une seule transition atomique fait foi ; les livraisons
  dupliquées concurrentes obtiennent `skip-busy`.

### Tests ajoutés (`tests/worker-processor.test.ts`, 12 tests, fake DB à sémantique réelle)
- Fake `PrismaClient` : `updateMany` atomique, `$transaction` avec **rollback par snapshot**,
  unicités `Slide(generationId,order)` et `CreditTransaction(userId,type,reference)` avec
  erreurs style P2002, LLM stub programmable (ok / throw / invalid-schema) + compteur d'appels.
- Premier traitement → COMPLETED : 5 slides ordonnées, exactement 1 débit, 1 activation, 1 appel LLM.
- Transitoire puis succès : attempt 1 `throw` → statut revenu **QUEUED**, 0 débit/slide ;
  attempt 2 → COMPLETED avec **2 appels LLM** (preuve de ré-exécution), toujours 1 débit/slides/activation.
- Transitoire persistant : attempts 0,1 `throw` ; attempt 2 (dernière) → `FAILED`, 0 débit, 0 slide.
- Sémantique (4 slides) → `FAILED/INVALID_RESPONSE` immédiat, 1 seul appel LLM, 0 débit.
- Livraison dupliquée en PROCESSING frais → `skipped`, 0 appel LLM.
- PROCESSING stale → reclaim + COMPLETED.
- Redélivrance après COMPLETED (ack perdu) → `skipped`, toujours 1 débit/1 event.
- `generationId` inconnu → `skipped`.
- Concurrence : 2 claims atomiques simultanés → exactement 1 `claimed` / 1 `skip-busy`.
- Double completion forcée → violation d'unicité → succès idempotent, toujours 1 débit.
- Unités `shouldRetry` (0,3→t / 1,3→t / 2,3→f / 0,1→f) et `isTransientError` (timeout/réseau/5xx vs sémantique).
- Résiduel R1 documenté par un test explicite : deux `check-then-act` parallèles passent tous
  deux (course applicative connue, garde DB encore à ajouter — le test l'atteste, il ne la masque pas).

### Résultats
| Vérification | Résultat |
|--------------|----------|
| Retry transitoire → ré-exécution réelle (2 appels LLM, 1 débit) | **PASS** (test dédié) |
| Épuisement → FAILED définitif, 0 débit | **PASS** |
| Concurrence : 1 seul propriétaire, idempotence débit/slides/activation | **PASS** |
| Retry réel via BullMQ + Redis (infra) | **NOT EXECUTED** (pas de Redis/Docker dans cet environnement) |

---

## Concurrence (demande Claude2)

Couverte par `tests/worker-processor.test.ts` : double claim atomique, double completion,
redélivrance terminale, `hasInProgress`/`hasCredits` documentés (course R1 attestée, non masquée),
contraintes uniques exercées (`Slide`, `CreditTransaction`). Voir § P0#2 ci-dessus.

## Validation obligatoire — commandes réellement exécutées

| # | Commande | Résultat |
|---|----------|----------|
| 1 | `pnpm install` (+ 3 micro-ajouts : `@nestjs/testing`, `@prisma/client`×2) | **PASS** |
| 2 | `prisma generate` (`pnpm --filter @slideify/schema db:generate`) | **PASS** (schéma inchangé depuis M004.1 ; régénéré sans erreur) |
| 3 | `pnpm -r --if-present typecheck` (8 projets) | **PASS** |
| 4 | `pnpm -r --if-present lint` | **PASS** (via `tsc`, réserve documentée en M004.1 : pas d'ESLint réel) |
| 5 | `pnpm test` | **PASS** — 5 suites, **46/46** (schema 3, generation 6, llm 16, auth 9, worker-processor 12) |
| 6 | `pnpm -r --if-present build` (8 projets, Next 9 pages) | **PASS** |
| 7 | `migrate deploy` | **NOT EXECUTED** — PG-18 local sans identifiants non interactifs ; daemon Docker inactif (`docker info` : pipe introuvable, réessayé) |
| 8–10 | API + worker live, flux register→COMPLETED, retry transitoire réel | **NOT EXECUTED** — Redis absent, PG inutilisable, Docker inactif (mêmes causes constatées et re-vérifiées cette session) |

## Fichiers — récapitulatif M004.2

Créés : `apps/api/src/auth/auth.module.ts`, `apps/worker/src/claim.ts`,
`apps/worker/src/processor.ts`, `tests/auth.test.ts`, `tests/worker-processor.test.ts`,
`docs/M004_2_P0_FIX_REPORT.md` (ce fichier).
Modifiés : `apps/api/src/auth/auth.controller.ts` (+`POST login`, 400 email),
`apps/api/src/app.module.ts` (AuthModule), `apps/worker/src/index.ts` (câblage fin),
`apps/api/package.json` + `apps/worker/package.json` (deps de test/typage),
`package.json` + `pnpm-lock.yaml` (dépendances ajoutées).
Supprimé : `apps/api/src/auth/jwt.module.ts` (doublon sans controller ; `JwtModule.register`
replié dans `AuthModule`, raison tracée ici).

## Risques résiduels (inchangés ou précisés)

- R1 (course `hasInProgress`/`hasCredits`) : toujours ouvert, désormais **attesté par test** ;
  correction = verrou consultatif PG ou index partiel + test de charge (exige PG).
- R3 (filtre d'exception global 404/know-error-codes) : `GenerationService.getStatus` lève encore
  `Error` générique → 500 au lieu de 404 ; `AuthService.login` idem (`User not found`).
- D-11 (crédits offerts dès `POST magic-link` sans vérification du lien) : comportement conservé,
  à trancher produit.
- `TRANSACTION_ERROR` (nouveau code opérationnel, échec de commit non-contrainte) : retombe sur
  le message générique côté front (§6.2 « autre / vide ») — conforme au contrat.
- E2E live (DB + Redis + retries BullMQ réels) : doit être rejoué dès qu'un environnement
  Docker/PG/Redis est disponible ; les simulations par fakes à sémantique réelle ne le remplacent pas.

## Statut final

**READY FOR RE-AUDIT** — les deux P0 sont corrigés avec preuves exécutées (46/46 tests,
typecheck/lint/build verts, wiring Nest prouvé par compilation de module, retry prouvé par
ré-exécution réelle dans le processeur de production). L'audit suivant devra rejouer le flux
live §§7–10 du brief dès qu'une infra PG + Redis existe ; en l'état, aucune régression
n'est introduite et aucun invariant n'a été affaibli pour faire passer les tests.
