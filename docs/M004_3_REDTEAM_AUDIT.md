# M004_3_REDTEAM_AUDIT.md — Re-audit final auth/sécurité de `c3d87b7`

Auditeur : Claude2, indépendant d'OpenCode. Commit audité : `c3d87b7` (`fix(m004.3): credential-based auth, remove email-only JWT issuance`) sur `fix/m004-recovery`, au-dessus de `80244a7`. Aucun fichier du dépôt n'a été modifié ; le seul fichier créé est ce rapport.

# VERDICT : **NO-GO**

**Raison unique et suffisante : l'API ne démarre pas.** En démarrant réellement `AppModule` (graphe de DI complet, vrai Redis), NestJS échoue avec :
`Nest can't resolve dependencies of the JwtAuthGuard (?). Please make sure that the argument JwtService at index [0] is available in the GenerationModule context.`
Cet échec est **indépendant de Prisma** et se reproduit à l'identique à `9cc2359` et `c3d87b7` (à `b65b1ad`, un échec voisin : `AuthService … PrismaService … JwtModuleNest`). **L'application n'a donc jamais pu démarrer sur aucun commit de `fix/m004-recovery`.** Conformément à la règle de la mission, M005 reste interdit et aucune recommandation de passage n'est faite.

> **Correction de mes propres audits précédents.** (1) Mon audit M004.2 a conclu que `AuthModule` était « structurellement câblé » et que l'API devenait atteignable : c'était une conclusion de lecture, **fausse en pratique** puisque l'application ne démarre pas — je n'avais pas pu la démarrer à l'époque et je n'aurais pas dû lui donner un CONDITIONAL GO sans cette réserve explicite. (2) Je rétracte aussi mon « 44 tests, pas 46 » : à `9cc2359` il y avait bien **46** tests (17+6+2+13+8) ; j'avais omis les 2 tests de `schema.test.ts` (bloqués par Prisma) de mon total. OpenCode avait raison sur ce chiffre. (3) Ma répartition par fichier de l'audit M004.1 (16/7) était inversée : `llm.test.ts` en compte 17 et `generation.test.ts` 6 (somme inchangée).

---

## 0. Ce qui a été exécuté réellement, et ce qui a été substitué

Le bac à sable a été réinitialisé entre deux sessions ; je l'ai reconstruit (clone de `fix/m004-recovery` @ `c3d87b7`, `pnpm install` depuis le lockfile, Redis et PostgreSQL 16 installés via `apt`).

| Élément | Statut |
|---|---|
| `pnpm install` | **PASS réel** (bcryptjs 3.0.3 installé) |
| Chaîne de migrations sur base PostgreSQL **vierge** (`20251002_m004_recovery_init` puis `20251006_m004_3_password_hash`, via `psql -v ON_ERROR_STOP=1`) | **PASS réel** ; `User.passwordHash text NOT NULL` et `User_email_key` UNIQUE vérifiés par `\d` |
| `prisma generate`, `migrate deploy` (CLI Prisma) | **NON EXÉCUTABLES** : `403 Forbidden` sur `binaries.prisma.sh` (liste blanche réseau du bac à sable), inchangé depuis le premier audit |
| `tsc --noEmit` par projet (8) | **5/8 PASS** (`shared`, `config`, `llm`, `renderer`, `web`) ; `schema`, `api`, `worker` échouent uniquement à cause du client Prisma non généré (même cause unique qu'avant, aucune régression) |
| `build` | `shared`, `config`, `llm`, `renderer` (tsc) et `web` (`next build`, 9 pages) **PASS réels** ; `schema`/`api`/`worker` bloqués par la même cause |
| `lint` | Alias de `tsc --noEmit` dans tous les `package.json` : aucun ESLint réel, donc « lint PASS » = typecheck |
| `jest` avec la config **du dépôt**, sans rien modifier | **23 tests passés**, 3 suites ne chargent pas (`auth`, `worker-processor`, `schema`) — cause unique : `@prisma/client` non généré |
| `jest` avec **seul le moteur natif `@prisma/client` remplacé par une classe vide** (jamais invoqué : les tests injectent un faux) | **48/48 passés** sur 4 suites (`auth` 12, `worker-processor` 13, `llm` 17, `generation` 6). Les 2 tests de `schema.test.ts` (client Prisma réel) restent non exécutables. **Total : 50 tests dans les fichiers = chiffre annoncé par OpenCode, confirmé.** |
| **Serveur HTTP réel + Redis/BullMQ réels + worker réel** | **EXÉCUTÉ**, avec **une seule substitution : la base de données** (un faux `PrismaService` en mémoire, avec des points d'asynchronisme pour que les requêtes concurrentes s'entrelacent vraiment). Réel : Nest/Express, `AppModule`, contrôleurs, guards, bcryptjs, JWT, Redis, file BullMQ, `Worker` BullMQ, `processGeneration`, `MockProvider`. Harnais écrit dans `tests-live-diag/` (non versionné, **non commité**, supprimable) ; il contient un contournement **uniquement dans le harnais** du P0 de démarrage (un `JwtModule` global fournissant `JwtService`) pour pouvoir tester la suite. |
| E2E avec **vrai PostgreSQL via Prisma** | **NON EXÉCUTÉ** — le client Prisma ne peut pas être généré ici. Tout ce qui dépend du comportement réel de Prisma/PostgreSQL sous charge est catégorie C (voir §9). |
| CI GitHub Actions sur la branche | **0 run** (requête API authentifiée, `total_count: 0`). Le workflow ne se déclenche que sur push/PR vers `main`/`develop`, et aucune PR vers ces branches n'a été ouverte pour `fix/m004-recovery` (seules les PR de documentation #12 et #13, ciblant la branche elle-même, ont existé). Tête distante au moment de l'audit : `c3d87b7`. |

Limite du harnais à garder en tête : l'entrelacement des requêtes vient de points `setImmediate` dans le faux, pas de la latence réelle de PostgreSQL. Les courses mesurées ci-dessous sont donc **des démonstrations réelles de l'existence d'une fenêtre de course dans le code**, pas des mesures de sa largeur en production.

---

## 1. AUTHENTICATION — vérifications demandées

| Point | Résultat | Preuve |
|---|---|---|
| `AuthModule` réellement câblé | **Importé dans `AppModule`, mais l'application ne démarre pas** (P0-1) | `app.module.ts` importe `AuthModule` ; démarrage réel : échec DI ci-dessus |
| `register` / `login` accessibles | ✅ (avec le contournement du harnais) | `POST /api/auth/register` → 201 ; `POST /api/auth/login` → 200 |
| `register` ne délivre pas de JWT | ✅ **prouvé en HTTP** | clés de la réponse : `userId, email, credits` ; aucun `accessToken`, aucun `passwordHash` |
| `login` ne délivre un JWT qu'après authentification | ✅ **prouvé** | `auth.service.ts:88-95` ; un seul site de signature dans tout le dépôt (`grep` : `auth.service.ts:43`, appelé en `:95` après la comparaison) |
| Mot de passe correctement haché, jamais en clair | ✅ **prouvé** | hash stocké `$2b$10$…`, 60 caractères ; recherche du mot de passe dans tout l'état de la base : absent |
| Mauvais mot de passe / email inexistant refusés, 401 | ✅ | les deux → `401 {"code":"INVALID_CREDENTIALS","message":"Email ou mot de passe invalide."}`, corps strictement identiques |
| « dummy-hash réellement utilisé » | ❌ **Inopérant — voir P2-1** | `auth.service.ts:15` : la constante fait **67 caractères** (un hash bcrypt valide en fait 60). `bcrypt.compare` la rejette immédiatement : **0 ms** contre **79,6 ms** pour un vrai hash. Sur HTTP : médiane **82,9 ms** (mauvais mot de passe) contre **1,6 ms** (email inexistant), 15 essais chacun. Le test unitaire correspondant ne compare que les corps de réponse, pas les temps. |
| JWT correctement signé | ✅ | `alg: HS256`, `typ: JWT`, payload `{sub, email, credits, iat, exp}` |
| Expiration JWT | 7 jours (`exp − iat = 604800`) ; `auth.module.ts:13` |
| Secret JWT | ⚠️ `env.ts:19` : `AUTH_SECRET: z.string().min(1)` — un secret d'**un seul caractère** est accepté ; `.env.example:23` : `AUTH_SECRET=` vide (P1-5) |
| `getMe` exclusivement basé sur le JWT | ✅ **prouvé** | `GET /auth/me?userId=user_999` avec le JWT de `user_1` → renvoie `user_1` |
| Usurpation via `userId` body/query | ✅ **impossible** | requête `?userId=…` ignorée ; `POST /generations` avec `{userId: <autre>}` dans le corps → génération créée pour l'identité du JWT (`createdFor == bId`) |
| JWT forgés | ✅ tous rejetés | `alg: none` → 403 ; payload modifié avec la signature d'origine → 403 ; signé avec un autre secret → 403 ; expiré → 403 ; absent/invalide → 403 |
| Ancien mécanisme email-seul / magic-link / route oubliée émettant un JWT | ✅ **aucun** | `POST /auth/magic-link`, `/auth/token`, `/auth/refresh`, `/auth/verify` → **404** ; un seul `jwtService.sign` dans le dépôt |

## 2. REGISTER

| Point | Résultat |
|---|---|
| Validation email | ⚠️ **faible** (`auth.controller.ts:7`) : seul `includes('@')` et `length ≤ 320`. Prouvé : `@` seul est accepté (201) ; `Victim@Example.com` et ` victim@example.com` (espace initial) sont acceptés comme **comptes distincts** de `victim@example.com`. Aucun `trim`/`lowercase`. |
| Validation mot de passe | ✅ longueur 8–128 (`auth.controller.ts:13`) ; type vérifié (tableau → 400) ; corps vide / JSON invalide → 400 |
| Hash avant persistance | ✅ (`auth.service.ts:58` avant `:60`) |
| Unicité / doublon | ✅ 409 `EMAIL_TAKEN`, **aucun second crédit** (1 seul grant constaté) ; contrainte `User_email_key` réelle en base |
| +3 crédits atomiques | Le code utilise `$transaction` (`auth.service.ts:60`). **Atomicité réelle non prouvable sans Prisma/PostgreSQL** ; avec le faux (rollback par instantané), pas de compte orphelin constaté. |
| Welcome credits multiples par répétition | ❌ **Contournable** : variantes de casse/espaces/`+alias` = autant de comptes à +3 crédits, sans vérification d'email ni limitation de débit (P1-4) |
| Course sur doublon concurrent | ❌ **6 inscriptions simultanées du même email → statuts `[201, 409, 409, 409, 500, 500]`** : la vérification préalable (`:53`) puis l'`INSERT` ne sont pas atomiques ; la violation d'unicité (`P2002`) n'est pas interceptée et sort en **500** au lieu de 409 (P2-3). Un seul compte créé (l'unicité tient). |
| Troncature bcrypt | `a`×80 enregistré, puis connexion avec `a`×72 + une queue différente → **200** : bcrypt ignore tout après 72 octets, alors que la validation autorise 128 (P3) |

## 3. JWT / SESSION — acceptable pour M004 ?

- **Algorithme** HS256 par défaut, vérification avec secret explicite (`jwt.guard.ts:20`) ; `alg:none` et signatures altérées rejetés : **acceptable**.
- **Expiration 7 j sans refresh/rotation/révocation** : acceptable pour un MVP local, **P2** (P1 avant ouverture publique).
- **Secret** : aucune contrainte de longueur/entropie (`env.ts:19`) : **P1 avant production**, trivial à fermer, non bloquant seul.
- **Payload** : contient `credits` figé à la signature ; `/auth/me` renvoie cette valeur périmée : après une génération, `/auth/me` annonce **3** alors que le solde en base est **2** (P2). Aucune décision de sécurité ne repose dessus (les contrôles de crédit relisent le ledger).
- **Codes HTTP** : token absent/invalide/expiré → **403** (`jwt.guard.ts:14,30` renvoie `false`), alors que le Swagger annonce 401 ; le client ne peut pas distinguer « expiré » de « interdit » (P2).

## 4. Les 50 tests — qualité réelle

Répartition mesurée : `auth` 12, `worker-processor` 13, `llm` 17, `generation` 6, `schema` 2 = **50** ✔.

**Solides et réellement probants** : l'attaque « email seul → 401 » (`tests/auth.test.ts`), le sel par utilisateur, l'identité des deux 401, l'absence de `accessToken`/`passwordHash` dans la réponse de `register`, le cycle claim→reset→re-claim→2ᵉ appel LLM, l'épuisement des tentatives, le stale reclaim, l'idempotence séquentielle du débit/slides. **Je les ai exécutés (48/48 avec le seul moteur natif stubé).** Ils testent la logique réelle (`AuthService`, `AuthController`, `JwtAuthGuard`, `claim.ts`, `processor.ts`) contre un faux en mémoire.

**Ce qu'ils ne couvrent pas — et qui est précisément ce qui cache le P0-1** :
1. **Aucun test ne démarre `AppModule`** : `auth.test.ts` ne boote que `AuthModule` ; aucun test n'instancie `GenerationModule`. Le défaut de DI aurait été détecté par un seul `Test.createTestingModule({imports:[AppModule]}).compile()`. Les tests « AuthModule compiles » créent un faux sentiment de câblage.
2. **Aucun test HTTP** (statuts réels, pipes, filtre d'exceptions, guards en situation) : c'est là que se trouvent les HTTP 201 pour des erreurs de validation (P1-3) et les 403 au lieu de 401.
3. **La « dummy-hash » est testée sans mesurer le temps** : le test passe alors que le mécanisme est inopérant (P2-1).
4. **« Duplicate register → 409 » est séquentiel** : la course réelle (2 × 500 constatés) n'est pas couverte.
5. **Aucun test de la course `hasInProgress`/`hasCredits` au niveau API** (le test R1 de `worker-processor.test.ts` simule la course sur une fonction locale du test, pas sur `GenerationService`/`GenerationController`).
6. **Le test « deux claims simultanés »** utilise un faux `updateMany` sans point d'attente interne : `Promise.all` s'y exécute en pratique séquentiellement. Il valide la logique sous hypothèse d'atomicité SQL, il ne prouve pas l'atomicité.
7. **Aucun test d'ownership** sur `GenerationService.getStatus`, ni d'indisponibilité Redis.
8. `tests/generation.test.ts` ne teste que des schémas/fonctions pures (`countWords`, `GenerationInputSchema`, `GenerationJobSchema`) — utile, mais ce n'est pas un test du service ni du contrôleur.

## 5. RÉGRESSION M004 — revalidation **en conditions réelles** (HTTP + Redis/BullMQ + worker réels, DB substituée)

| Point critique | Résultat | Preuve observée |
|---|---|---|
| Queue BullMQ réelle injectée | ✅ | `POST /generations` → job consommé par un vrai `Worker` BullMQ ; `generation.service.ts:34` |
| Payload `{generationId}` seul | ✅ | `generation.service.ts:34-40` ; consommé tel quel |
| Worker unique | ✅ | un seul consommateur (`apps/worker`) ; `apps/api/src/worker` et `payment` toujours absents |
| Claim atomique | ✅ (sous hypothèse d'atomicité SQL) | aucune double exécution constatée ; 5 POST concurrents n'ont produit aucun double traitement d'une même génération |
| **Retry transitoire** | ✅ **prouvé en réel** | génération « flaky » : tentatives `[0: THROW ECONNRESET, 1: completed]`, **2 appels LLM**, 5 slides, **1 débit**, 1 activation, 2,1 s (backoff BullMQ réel) |
| Retries épuisés | ✅ | `THROW, THROW, failed` → `FAILED/TIMEOUT` en 6,1 s ; 0 slide, 0 débit, solde intact (3) ; l'utilisateur peut relancer (pas de verrouillage) |
| Erreur sémantique | ✅ | `__MOCK_SCHEMA_INVALID__` : 1 seule tentative, `FAILED/MALFORMED_OUTPUT`, 0 slide, 0 débit |
| Stale reclaim | ✅ | génération `PROCESSING_LLM` vieille d'1 h + job réel → `COMPLETED`, 5 slides, 1 débit ; une génération `PROCESSING` **récente** n'est pas volée |
| Idempotence slides / débit / activation | ✅ | job dupliqué (autre `jobId`) sur une génération terminée → 1 débit, 5 slides, 1 événement ; même `jobId` → dédupliqué par BullMQ |
| Word count | ✅ | 79 mots et 3001 mots rejetés, 0 ligne créée (80/3000 couverts par tests unitaires) |
| Propriété des générations | ⚠️ **correct mais 500** | B lit la génération de A → **500** (corps identique à un id inexistant : aucune fuite) ; `generation.service.ts:57` lève un `Error` natif |
| Historique cloisonné | ✅ | B voit 0 génération ; `userId` du corps ignoré |
| Prisma / transactions | **C** | schéma et migrations valides en vrai PostgreSQL ; comportement réel du client non exécutable |
| Aucun problème ancien réintroduit | ✅ | `generation.service.ts`, `claim.ts`, `processor.ts`, `packages/llm`, `packages/renderer` inchangés par M004.3 |

## 6. Constats nouveaux, classés

### P0 — bloque M005
**P0-1. L'API ne démarre pas (DI NestJS).** `apps/api/src/generation/generation.module.ts:8-9` n'importe que `PrismaModule` et la file BullMQ ; `apps/api/src/generation/generation.controller.ts:13,66,77` applique `@UseGuards(JwtAuthGuard)`, dont le constructeur exige `JwtService` ; `apps/api/src/auth/auth.module.ts:19` n'exporte que `AuthService` et `JwtAuthGuard` (pas `JwtModule`). Reproduction : instancier `AppModule` (hors Prisma) → l'erreur ci-dessus. Présent à `9cc2359` et `c3d87b7`. **Aucun des 50 tests ni la validation annoncée ne le détecte.** Attendu : `AppModule` démarre et sert `/api/health`. Réel : échec au démarrage — aucune route n'est servie.

### P1 — correction nécessaire avant production (certains à traiter avant M005, voir §10)
**P1-1. Invariant de crédit violé : solde négatif prouvé.** Solde = 1, 5 `POST /generations` concurrents (HTTP réel) → réponses `[QUEUED, QUEUED, IN_PROGRESS, IN_PROGRESS, IN_PROGRESS]`, **2 générations créées, 2 complétées, 2 débits, solde final −1**. Cause : vérification `hasInProgress` puis `hasCredits` puis `create` non atomiques (`generation.controller.ts:40-58`, `generation.service.ts:25,77,89`) ; le débit n'a lieu qu'à la complétion. Risque connu depuis le premier audit et déclaré par OpenCode ; **maintenant prouvé sur le code réel**. En production la fenêtre dépend de la latence PostgreSQL (non mesurable ici).
**P1-2. Panne Redis au moment du POST : requête suspendue puis utilisateur verrouillé à vie.** Redis arrêté : `POST /generations` ne répond pas (>25 s, aucune borne), mais la ligne `QUEUED` est déjà créée (`generation.service.ts:26-33` puis `:34`) ; Redis relancé : la ligne reste `QUEUED` **sans aucun job**, et tout nouveau POST renvoie `GENERATION_IN_PROGRESS` — aucun reaper ne la débloque (le « stale reclaim » ne s'applique qu'à un job redélivré). Verrouillage permanent jusqu'à intervention manuelle en base.
**P1-3. Les erreurs de validation sont renvoyées avec un statut HTTP 201.** `generation.controller.ts:15` (`@HttpCode(201)`) + `:25-55` (`return { statusCode: 400/403/402, … }` : un objet retourné ne change pas le statut). Observé : 79 mots, 3001 mots, corps sans `sourceText`, génération déjà en cours → **tous HTTP 201** avec `statusCode:400/403` dans le corps. Les clients, proxys et la supervision voient des succès.
**P1-4. Aucune limitation de débit, aucune vérification d'email, email non normalisé** (`auth.controller.ts:7`) : inscriptions illimitées à +3 crédits (variantes de casse/espaces/alias, `@` accepté), force brute sur `/auth/login` non freinée, coût CPU bcrypt exposé. (R-E d'OpenCode, confirmé et aggravé par l'absence de normalisation.)
**P1-5. `AUTH_SECRET` sans exigence de longueur** (`env.ts:19`, `.env.example:23` vide).

### P2 — amélioration
- **P2-1. Dummy-hash inopérante** (`auth.service.ts:15`, 67 caractères) : fuite temporelle 82,9 ms vs 1,6 ms. Impact incrémental limité car `register` énumère déjà les emails (R-D) ; mais **l'affirmation « le login ne révèle rien » est fausse** et le test censé la couvrir ne mesure pas le temps.
- **P2-2.** 403 au lieu de 401 pour token absent/invalide/expiré (`jwt.guard.ts:14,30`).
- **P2-3.** Course sur `register` → 500 au lieu de 409 (`auth.service.ts:53-60`).
- **P2-4.** `getStatus` : `Error` natif → 500 « Internal server error » et pas de filtre d'exceptions global (`generation.service.ts:57`) ; aucune fuite constatée.
- **P2-5.** `/auth/me` renvoie des crédits périmés (valeur du JWT).
- **P2-6.** JWT 7 j sans révocation (R-C).

### P3 — dette mineure
- Troncature bcrypt à 72 octets (validation à 128) ; coût bcrypt 10 (~80 ms mesurés ici — R-B : monter à 12 avant exposition) ; validation d'email minimale ; `credits.service.ts` code mort ; modèles `Output`/`WebhookEvent` sans producteur ; `lint` = `tsc` ; l'historique renvoie les lignes complètes (dont `sourceText`).

## 7. Les risques résiduels d'OpenCode, un par un

| Risque | Mon analyse | Classe |
|---|---|---|
| R-A. E2E live en attente | **Exécuté ici (DB substituée)** : il a révélé le P0-1 et 4 problèmes P1. Reste à rejouer avec le vrai PostgreSQL/Prisma. | — |
| R-B. bcrypt coût 10 | ~80 ms/compare mesuré ; acceptable MVP | P3 |
| R-C. JWT 7 j | acceptable local, à durcir avant ouverture | P2 |
| R-D. 409 au register | arbitrage classique ; mais « login ne révèle rien » est démenti par le timing (P2-1) | P2 |
| R-E. Pas de rate-limit | brute force + farming de crédits + CPU bcrypt | **P1** |
| R-F. Migration `NOT NULL` | applique proprement sur base vierge (vérifié) ; échouerait sur une table non vide, comme documenté | P3 |
| R-G. Timing d'attribution des crédits | résolu : grant dans la transaction du `register` | — |

## 8. Comparaison avec les audits précédents

| Constat antérieur | État |
|---|---|
| P0 M004.1 « aucun JWT émis » | Corrigé : `register`/`login` existent, JWT émis après authentification |
| P0 M004.2 « email seul → JWT » | **Corrigé et prouvé** (attaque simulée → 401, en test et en HTTP réel) |
| P0 M004.1 « retry cassé par le claim » | **Corrigé et prouvé en réel** (§5) |
| Race `hasInProgress`/`hasCredits` | **Toujours présente, maintenant démontrée : solde −1** (P1-1) |
| Absence de reaper | **Toujours présente, maintenant démontrée** (P1-2) |
| `getStatus` → `Error` natif | Toujours présent (P2-4) |
| Boot de l'API | **Nouveau P0-1 : n'a jamais fonctionné ; raté par mes audits précédents faute de pouvoir démarrer l'app** |

## 9. Synthèse A / B / C / D

**A — Vérifié et corrigé (preuve par exécution réelle HTTP/Redis/BullMQ, DB substituée)** : register sans JWT ; login → JWT seulement après authentification ; hash bcrypt salé, jamais en clair ; 401 identiques ; JWT HS256 signé/expirant ; rejet de `alg:none`, payload altéré, mauvais secret, expiré ; `getMe` basé sur le JWT ; aucun `userId` client pris en compte ; ancien magic-link/email-seul supprimé (routes 404) ; retry transitoire réel avec 2ᵉ appel LLM ; épuisement → FAILED sans débit ; erreur sémantique sans retry ; stale reclaim ; non-vol d'un traitement frais ; idempotence slides/débit/activation sur job dupliqué ; validation du nombre de mots ; migrations valides en vrai PostgreSQL ; 50 tests présents (48 exécutés).
**B — Vérifié par tests unitaires/faux uniquement** : atomicité de la transaction `register` (rollback simulé) ; atomicité du claim (hypothèse `UPDATE … WHERE` atomique) ; contrainte d'unicité du débit sous deux complétions *réellement* concurrentes.
**C — Non vérifiable ici** : `prisma generate` / `migrate deploy` via la CLI ; comportement du vrai client Prisma (notamment le texte de l'erreur d'unicité sur lequel s'appuie `processor.ts:274`) ; largeur réelle des fenêtres de course sur PostgreSQL ; E2E avec vrai PostgreSQL.
**D — Problèmes restants** : P0-1 ; P1-1 à P1-5 ; P2-1 à P2-6 ; P3 ci-dessus.

## 10. Conditions pour sortir de la phase de recovery

1. **Corriger P0-1** (l'API doit démarrer) et **ajouter un test qui boote `AppModule`**. Sans cela, rien de ce qui précède ne peut être servi.
2. Rejouer ce même parcours live sans contournement, puis avec le vrai PostgreSQL/Prisma dans un environnement non restreint (la CI du dépôt, déjà dotée de Postgres/Redis, convient — elle n'a encore jamais exécuté cette branche).
3. **Avant M005** (le rendu multiplie le coût par génération), je recommande de fermer P1-1 (invariant de crédit), P1-2 (verrouillage après panne Redis) et P1-3 (statuts HTTP), qui touchent le cœur du pipeline. P1-4/P1-5 sont à fermer avant toute exposition publique.
4. Ajouter les tests manquants listés §4 (boot `AppModule`, HTTP réel, timing de la dummy-hash, course d'API).

Le travail de M004.3 sur l'authentification est **bon sur le fond** : la faille d'usurpation par email est réellement éliminée et prouvée. Mais M004 ne peut pas « sortir de la recovery » : une application qui ne démarre pas n'a pas de validation finale possible.
