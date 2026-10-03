# M004_1_REDTEAM_AUDIT.md — Audit indépendant de `fix/m004-recovery`

Auditeur : Claude2 (QA Lead / Security Reviewer / Growth Reviewer), indépendant d'OpenCode.
Branche auditée : `fix/m004-recovery` @ `b65b1ad` (4 commits : `0954bf8`, `17338d3`, `0b69f24`, `b65b1ad` — le rapport d'OpenCode en annonçait trois ; il y en a quatre, le premier étant un commit de mise en place dont le message est un titre de mission plutôt qu'un message de commit conventionnel).
**Le rapport d'OpenCode n'a été pris comme preuve pour rien : chaque affirmation ci-dessous a été vérifiée directement sur le code, et, chaque fois que l'environnement le permettait, par exécution réelle.** Aucun fichier du dépôt n'a été modifié ; un `tsconfig.json`/une configuration Jest de diagnostic utilisés lors de l'audit précédent ont été nécessaires une fois de plus puis supprimés — voir §0.

## 0. Ce qui a été réellement exécuté, et ce qui ne pouvait pas l'être ici

**Exécuté avec succès dans cette session** (Redis et PostgreSQL 16 installés localement via `apt-get`, domaines autorisés) :
- `pnpm install --config.minimum-release-age=0 --ignore-scripts` → succès, à partir du **vrai `pnpm-lock.yaml` désormais commité** (amélioration réelle : l'audit précédent n'avait aucun lockfile versionné).
- `psql` : application directe du fichier `packages/schema/prisma/migrations/20251002_m004_recovery_init/migration.sql` sur une base PostgreSQL 16 réelle → **succès complet, zéro erreur** (3 `CREATE TYPE`, 7 `CREATE TABLE`, 14 `CREATE INDEX`, 5 `ALTER TABLE`). Vérifié ensuite par `\d` dans `psql` : les contraintes `CreditTransaction_userId_type_reference_key` (UNIQUE sur `userId, type, reference`) et `Slide_generationId_order_key` (UNIQUE sur `generationId, order`) existent réellement en base, ainsi que `title VARCHAR(60)` / `body VARCHAR(220)`.
- `npx tsc --noEmit -p tsconfig.json` exécuté séparément pour **chacun** des 8 paquets/apps (`packages/shared`, `packages/config`, `packages/llm`, `packages/renderer`, `packages/schema`, `apps/api`, `apps/worker`, `apps/web`) — résultats bruts cités section 1.
- `npx jest --config jest.config.js` (le vrai `jest.config.js` racine ajouté par la branche, sans configuration de diagnostic cette fois) — résultat brut cité section 2.
- `npx tsc -p tsconfig.json` (build) pour les 4 paquets purs, et `npx next build` réel pour `apps/web`.
- Recherche exhaustive sur GitHub (API) : branches, PRs (tous états), recherche de commits — pour confirmer l'existence et l'état réel de la branche.

**Tenté sans succès, pour une raison d'environnement et non de code** :
- `npx prisma generate` et `npx prisma migrate deploy` échouent tous les deux avec `403 Forbidden` sur `https://binaries.prisma.sh/...` : ce domaine n'est pas sur la liste blanche réseau de ce bac à sable (domaines autorisés : npm, PyPI, crates.io, GitHub, Ubuntu — pas `binaries.prisma.sh`). **Ce n'est pas un défaut du code** : le schéma lui-même est valide (voir le succès de l'application directe via `psql` ci-dessus) — c'est l'impossibilité, ici, de télécharger le moteur binaire Prisma qui bloque la génération du client. Conséquence en cascade documentée précisément section 1.
- Impossible de démarrer réellement l'API ou le worker (`nest start`, `node dist/index.js`) : ils importent tous deux `PrismaService`/`prisma`, qui dépend du client généré — bloqué pour la même raison.
- Impossible de rejouer dynamiquement les scénarios HTTP (A/B, double POST, race de crédits) contre un serveur réel, pour la même raison.
- **CI GitHub Actions n'a jamais tourné sur cette branche** (`GET /actions/runs?branch=fix/m004-recovery` → `total_count: 0`) : le workflow ne se déclenche que sur push/PR vers `main`/`develop`, et aucune PR n'a jamais été ouverte pour `fix/m004-recovery` (vérifié via l'API : liste des PRs tous états, aucune ne référence cette branche). **Les chiffres annoncés par OpenCode (8/8, 25/25, 8/8) n'ont donc été validés ni par ce bac à sable, ni par la CI du dépôt — ils ne peuvent provenir que de l'environnement local d'OpenCode, que je ne peux pas inspecter.**

**Conclusion de méthode** : je ne peux ni confirmer ni infirmer les chiffres exacts d'OpenCode pour tout ce qui dépend du client Prisma généré. Ce que je peux affirmer avec certitude, par exécution réelle : la cause de l'échec ici est unique, précisément identifiée, strictement environnementale (réseau), et n'importe quel environnement avec un accès réseau normal (y compris la CI du dépôt, qui provisionne déjà Postgres/Redis en service) la contournerait. Je donne donc le bénéfice du doute sur ce point précis tout en le signalant comme non vérifié par moi.

---

## 1. Typecheck — résultat réel, par paquet

| Paquet/app | Commande exécutée | Résultat réel |
|---|---|---|
| `packages/shared` | `tsc --noEmit -p tsconfig.json` | ✅ **PASS** (0 erreur) |
| `packages/config` | idem | ✅ **PASS** (0 erreur) |
| `packages/llm` | idem | ✅ **PASS** (0 erreur) |
| `packages/renderer` | idem | ✅ **PASS** (0 erreur) |
| `packages/schema` | idem | ❌ **FAIL** — 1 erreur : `src/prisma.ts(2,10): error TS2305: Module '"@prisma/client"' has no exported member 'PrismaClient'` |
| `apps/api` | idem | ❌ **FAIL** — 17 erreurs, **toutes** de la forme `Property 'X' does not exist on type 'PrismaService'` ou `has no exported member 'PrismaClient'` |
| `apps/worker` | idem | ❌ **FAIL** — 2 erreurs : la même `has no exported member 'PrismaClient'`, plus `Parameter 'tx' implicitly has an 'any' type` (ligne 212, le callback de `$transaction`) |
| `apps/web` | `next build` (inclut le typecheck Next) | ✅ **PASS** (0 erreur) |

**Analyse de la cascade** : `apps/api/src/prisma/prisma.service.ts` fait `export class PrismaService extends PrismaClient {...}`. Sans client généré, `PrismaClient` est un type vide/`any`, donc **chaque** accès `this.prisma.generation`, `this.prisma.creditTransaction`, `this.prisma.user`, `this.prisma.$transaction` échoue avec exactement ce message. J'ai vérifié que les 17 erreurs d'`apps/api` et les 2 d'`apps/worker` correspondent toutes, une par une, à cette unique cause — confirmé en lisant chaque ligne citée par le compilateur. **Verdict : 5 des 8 cibles passent réellement et indépendamment (`shared`, `config`, `llm`, `renderer`, `web`) ; les 3 autres échouent pour une seule et même cause, elle-même strictement environnementale ici (§0).** Le compte « 8/8 » d'OpenCode est donc plausible dans un environnement où `prisma generate` réussit, mais je ne l'ai pas observé moi-même pour ces 3 cibles.

**Fait vérifié indépendamment de la cascade** : à l'intérieur même d'`apps/api`, deux fichiers orphelins (`auth.service.ts`, `credits.service.ts`) génèrent des erreurs de la cascade bien qu'ils ne soient **câblés dans aucun module actif** (voir §4, AUTH). Une fois Prisma généré, il faudra revérifier qu'aucune erreur indépendante ne se cache sous cette cascade dans ces deux fichiers précis, puisqu'ils n'ont pas pu être testés en profondeur ici.

## 2. Tests — résultat réel

Commande exécutée : `DATABASE_URL=<sentinelle> AUTH_SECRET=<sentinelle> REDIS_HOST=localhost REDIS_PORT=6379 npx jest --config jest.config.js` (le vrai `jest.config.js` racine ajouté par cette branche — plus besoin de configuration de diagnostic cette fois, contrairement à l'audit M004 précédent).

```
PASS tests/llm.test.ts (6.69 s)
PASS tests/generation.test.ts
FAIL tests/schema.test.ts
  ● Test suite failed to run
    packages/schema/src/prisma.ts:2:10 - error TS2305: Module '"@prisma/client"' has no exported member 'PrismaClient'.

Test Suites: 1 failed, 2 passed, 3 total
Tests:       23 passed, 23 total
```

**23 tests exécutés et passés réellement, 1 suite bloquée (2 tests qu'elle contient, comptés par lecture directe du fichier, jamais exécutés) — total 23+2 = 25, exactement le chiffre annoncé par OpenCode.** La suite bloquée (`tests/schema.test.ts`) échoue pour l'unique raison déjà identifiée en §0/§1 (client Prisma non généré) — pas une régression propre à cette branche. **Le chiffre « 25/25 » d'OpenCode est donc cohérent avec ce que j'observe, à ceci près que je n'ai pu faire passer que 23 de ces 25 dans ce bac à sable spécifiquement**, pour une raison que j'ai isolée avec certitude et qui n'a rien à voir avec la qualité du code testé.

### Qualité et pertinence réelle des 25 tests (demande explicite de la mission)

J'ai lu les trois fichiers en entier. Constat important, indépendant de leur statut PASS/FAIL :

- `tests/generation.test.ts` (7 tests, tous passés) ne teste **que** des fonctions pures et synchrones : `countWords`, `GenerationInputSchema` (79/80/3000/3001 mots), `GenerationJobSchema` (accepte `{generationId}`, rejette l'absence du champ et un `sourceText` qui fuiterait dans le payload). **Il ne teste à aucun moment `GenerationService`, `GenerationController`, ni aucun comportement avec état.**
- `tests/llm.test.ts` (16 tests, tous passés) teste `MockProvider` et les schémas Zod associés (nombre de slides, conformité à `SlideSchema`, détection de langue, bornes `GenerationInputSchema`).
- `tests/schema.test.ts` (2 tests, non exécutables ici) ne vérifie que l'instanciation du client Prisma et la présence des propriétés de modèle — pas une vraie requête.

**Scénarios critiques absents des 25 tests, alors qu'ils sont au cœur même de cette mission de récupération** :
1. **Aucun test de la prise atomique `updateMany`** (le cœur de la correction « atomic claim » annoncée) — ni avec une vraie base, ni avec un mock Prisma simulant deux appels concurrents.
2. **Aucun test du débit idempotent** ni de la contrainte unique `(userId, type, reference)` — alors que c'est l'un des mécanismes les plus importants de cette branche et qu'il est parfaitement testable avec un mock Prisma renvoyant une erreur de contrainte unique simulée, sans base réelle.
3. **Aucun test de la race `hasInProgress`/`hasCredits`** — alors qu'elle est explicitement listée comme risque résiduel connu par OpenCode lui-même ; un test (même unitaire, avec Prisma mocké) qui lance deux `create()` en parallèle et vérifie le nombre de lignes créées aurait été possible sans base réelle.
4. **Aucun test du retry transitoire ni de l'event `worker.on('failed')`/`'completed'`** — voir §3.1 ci-dessous : ce point aurait justement permis de détecter, par un test, le bug P0 que j'ai trouvé par lecture.
5. **Aucun test de contrôle de propriété** (`getStatus` d'un utilisateur A appelé avec le userId de B) — alors que c'est explicitement demandé par cette mission et par les précédentes.
6. **Aucun test d'intégration bout-en-bout du worker** (LLM → validation → transaction de complétion), même avec un `MockProvider` et un Prisma entièrement mocké en mémoire (sans nécessiter de vraie base).
7. Les points 1, 2, 3 et 6 sont réalisables **sans PostgreSQL ni Redis réels** (mock de `PrismaClient`/`Queue`) — leur absence n'est donc pas imputable à une contrainte d'environnement, contrairement au reste de cet audit.

**Conclusion sur les tests** : les 25 tests sont corrects et utiles pour ce qu'ils couvrent (contrats d'entrée, forme du payload, mock LLM), mais **ils ne couvrent aucun des risques de concurrence, d'idempotence ou d'atomicité que cette mission de récupération prétend précisément avoir corrigés.** Un score « 25/25 » ne doit pas être lu comme une preuve que ces mécanismes fonctionnent — il prouve seulement que les fonctions pures testées fonctionnent.

## 3. Constats par priorité demandée

### 3.1 Concurrence et double génération — **P0, bug réel et nouveau, trouvé par lecture de code**

**Le mécanisme de retry transitoire est structurellement cassé par le pattern de claim atomique lui-même**, et bloque une génération pour toujours dès la première erreur transitoire.

Preuve (`apps/worker/src/index.ts`, lignes ~78-86 et ~130-150) :
1. À la prise en charge du job, `prisma.generation.updateMany({where: {id, status: QUEUED}, data: {status: PROCESSING_LLM, ...}})` fait passer la génération de `QUEUED` à `PROCESSING_LLM` — **immédiatement, avant tout appel LLM**.
2. Si l'appel LLM échoue avec une erreur jugée transitoire (`isTransientError`, ou le marqueur `__MOCK_TIMEOUT__`), le code fait `throw error` pour laisser BullMQ retenter (`attempts: 3`, backoff exponentiel) — **sans jamais remettre le statut à `QUEUED`**.
3. Quand BullMQ redélivre le **même job** (même `jobId`) pour la tentative 2, le processor recommence depuis le début — y compris l'étape 1 : `updateMany({where: {status: QUEUED}, ...})`. Mais le statut en base est maintenant `PROCESSING_LLM`, pas `QUEUED` → `claimed.count === 0`.
4. Le code entre alors dans la branche « déjà pris, idempotent » : il logue `déjà PROCESSING_LLM, skipping (idempotent)` et fait **`return`** (pas `throw`) — **sans jamais réessayer l'appel LLM, et sans jamais marquer la génération `FAILED`.**
5. BullMQ, ne voyant aucune exception, considère le job comme **réussi** (`worker.on('completed')` se déclenche). Plus aucune tentative n'aura lieu.

**Conséquence** : à la première erreur transitoire (un simple timeout réseau, un 503 passager), la génération reste bloquée en `PROCESSING_LLM` **pour toujours**, BullMQ la considère comme terminée avec succès, et `hasInProgress()` bloquera indéfiniment toute nouvelle génération pour cet utilisateur (aucun reaper n'existe pour la débloquer — risque déjà documenté dans les audits précédents, toujours vrai ici). C'est un comportement strictement pire que l'absence totale de retry : le système *prétend* retenter, échoue silencieusement à le faire, et masque l'échec à BullMQ.

- **Test de reproduction** (réalisable sans base réelle, avec un Prisma mocké qui simule `updateMany` renvoyant `count:1` puis `count:0` sur les deux appels successifs, et un `MockProvider` renvoyant le marqueur `__MOCK_TIMEOUT__`) : lancer le `main()` du worker sur un job, laisser BullMQ retenter une fois, vérifier que la génération ne passe ni `FAILED` ni `COMPLETED` et reste `PROCESSING_LLM`.
- **Attendu** : une erreur transitoire retentée doit effectivement refaire l'appel LLM à la tentative suivante.
- **Observé** : la tentative suivante ne fait rien et se déclare silencieusement réussie.
- **Recommandation** : avant de relancer (`throw`) une erreur transitoire, remettre explicitement le statut à `QUEUED` (ou introduire un état intermédiaire dédié aux tentatives, par ex. ne faire la transition `QUEUED→PROCESSING_LLM` qu'une fois l'appel LLM terminé avec succès, et garder un verrou distinct — par ex. `attemptCount`/`lockedUntil` — pour empêcher le traitement parallèle sans empêcher le retry séquentiel).

### 3.2 Double débit ou perte de crédits — **partiellement corrigé, vérifié par la structure de la base**

La contrainte `@@unique([userId, type, reference])` sur `CreditTransaction`, avec `reference: generation:${generationId}`, existe réellement en base (vérifié par `\d` PostgreSQL, §0). Le code du worker capture bien la violation de cette contrainte (`message.includes('Unique constraint')`) et la traite comme un succès idempotent. **C'est une conception correcte et vérifiée au niveau du schéma.** Réserve : je n'ai pas pu exécuter réellement deux complétions concurrentes contre une vraie instance Postgres (bloqué par §0), donc je n'ai vérifié la **forme** du mécanisme (contrainte + capture d'erreur), pas son comportement sous charge réelle. Aucun test automatisé ne le couvre non plus (§2).

### 3.3 Idempotence des événements — **conception correcte, non testée dynamiquement**

`GenerationEventName.FIRST_GENERATION_COMPLETED` n'est créé que si `completedCount === 1` (comptage des générations `COMPLETED` de l'utilisateur) **à l'intérieur de la même transaction** que le débit et le passage à `COMPLETED` — cohérent et atomique dans sa conception. Même réserve que 3.2 : non vérifié dynamiquement.

### 3.4 Retries BullMQ et erreurs transitoires — **voir 3.1 : cassé, pas corrigé**

La classification des erreurs (`isTransientError`) est elle-même raisonnable (ECONNRESET, ETIMEDOUT, 429, 5xx) et le principe « throw pour transitoire, update+return pour définitif » est le bon pattern — **mais son interaction avec la prise atomique en 1 seule étape le rend inopérant**, comme démontré en 3.1. Le retry « silencieux » sur JSON invalide (une tentative de re-génération avant d'abandonner) n'est, lui, pas affecté par ce bug puisqu'il est géré **à l'intérieur de la même exécution de job**, sans passer par un nouveau cycle BullMQ — celui-là fonctionne tel que conçu.

### 3.5 Atomicité de la complétion — **réelle, bien conçue**

`prisma.$transaction(async (tx) => {...})` regroupe : suppression puis recréation des slides, passage à `COMPLETED` + `slideCount` + `completedAt`, débit de crédit, et événement d'activation conditionnel — les quatre dans une seule transaction. C'est la bonne pratique, et une nette amélioration par rapport aux versions précédentes (où ces étapes étaient dispersées). Non vérifié dynamiquement (§0).

### 3.6 Sécurité JWT et contrôle de propriété — **P0 : aucune route n'émet jamais de JWT, la totalité de l'API est inatteignable**

- `apps/api/src/auth/auth.controller.ts` **existe toujours comme fichier**, mais n'est déclaré dans **aucun** `@Module({controllers: [...]})` du projet (confirmé : `app.module.ts` n'importe que `PrismaModule, BullMQModule, JwtModuleNest, GenerationModule` ; `JwtModuleNest` ne déclare que des `providers`, pas de `controllers`). **`AuthController` n'est donc enregistré nulle part : aucune route `/auth/*` n'existe dans l'application réelle.**
- Conséquence directe : il n'existe **aucun moyen, pour un client réel, d'obtenir un JWT valide.** `JwtAuthGuard` protège `POST /generations`, `GET /generations/:id/status`, `GET /generations` — les trois seules routes métier de l'application — et rejettera **toute** requête, puisqu'aucun jeton légitime ne peut jamais être émis. C'est une régression par rapport à l'audit précédent (où le problème était « le magic-link ne vérifie pas la possession de l'email » — un problème de sécurité sur un flux qui existait ; ici, le flux n'existe plus du tout, nulle part, dans le graphe de modules actif).
- Le contrôle de propriété lui-même, dans `generation.service.ts::getStatus` (`if (!generation || generation.userId !== userId) throw new Error(...)`), **est correct et inchangé** — mais reste un `Error` natif, pas une `HttpException`, donc toujours pas de filtre d'exception global (risque explicitement et honnêtement déclaré par OpenCode, confirmé réel).
- **Reproduction** : lire `app.module.ts` et chercher toute déclaration de `AuthController` dans un `controllers: [...]` de n'importe quel module importé — absente. Aucune exécution dynamique n'est nécessaire pour confirmer ce point, c'est un fait structurel du graphe de modules.
- **Recommandation** : créer `auth.module.ts` qui déclare `AuthController`, l'importer dans `AppModule`, et — point déjà soulevé dans les audits précédents, toujours valable — faire en sorte que ce contrôleur vérifie réellement la possession de l'email avant d'émettre des crédits gratuits et un JWT.

### 3.7 Validation des entrées — **réelle, vérifiée par exécution**

`countWords` est maintenant la seule source de vérité, utilisée à la fois par `GenerationInputSchema` (Zod, désormais basé sur un vrai comptage de mots et non plus sur la longueur de chaîne) et par le contrôleur. Vérifié par les 7 tests réels de `tests/generation.test.ts` (79/80/3000/3001 mots, tous passés). `Slide.title`/`Slide.body` sont maintenant tronqués au mot le plus proche (`truncateAtWord`) **avant** la validation du schéma, avec contrainte miroir en base (`VarChar(60)`/`VarChar(220)`, vérifié en base réelle). C'est un point clairement et solidement corrigé.

### 3.8 Cohérence Prisma/API/worker — **voir §1 : la cohérence de schéma est bonne, l'exécution est bloquée par l'environnement ici**

`GenerationStatus` (enum Prisma) correspond maintenant exactement à l'enum partagé TypeScript (`QUEUED, PROCESSING_LLM, PROCESSING_RENDER, COMPLETED, FAILED`, plus de `CREATED` fantôme). Le payload de job (`{generationId}` uniquement) est identique entre `generation.service.ts` (producteur) et `apps/worker/src/index.ts` (consommateur), et testé par `tests/generation.test.ts` (`GenerationJobSchema`).

### 3.9 Jobs bloqués et timeouts — **mécanisme partiel, et aggravé par 3.1**

`GENERATION_TIMEOUT_MS = 90_000` avec des points de contrôle `checkBudget()` existe à l'intérieur d'une exécution de job — mais ce n'est **pas un reaper** : rien ne scanne la base pour détecter une génération dont la ligne est bloquée en `PROCESSING_LLM` depuis plus de 90 secondes **après la fin du job** (ou, comme démontré en 3.1, après un retry silencieusement avorté). Risque déjà documenté dans les audits précédents (Q-03), **toujours présent**, et désormais atteignable par un chemin encore plus direct (3.1).

### 3.10 Exposition de données dans les logs — **inchangé, risque modéré, confirmé par lecture**

`logger.error(...)` dans le worker journalise `error.message` (pas l'objet complet) — raisonnable mais toujours sans liste de motifs à masquer (clé API, chaîne de connexion). Aucun filtre d'exception global côté API (confirmé §3.6). Risque déjà déclaré par OpenCode lui-même (« absence de redaction complète des logs ») — confirmé réel et toujours présent, sans changement depuis l'audit précédent.

### 3.11 Compatibilité avec M005 — **rupture de compatibilité réelle et assumée, à confirmer avec le produit**

M005 (`docs/M005_PRODUCT_RENDERING_SPEC.md`) suppose un écran Résultat qui affiche/télécharge des slides rendues (PNG/PDF/ZIP) — `packages/renderer` (rendu Puppeteer, stockage) **n'est plus importé nulle part** dans le worker ni dans l'API (confirmé par recherche exhaustive : `grep -rn "renderer\|renderSlides\|StorageAdapter"` ne trouve plus aucune référence hors du paquet `renderer` lui-même). Le modèle `Output` existe toujours dans le schéma Prisma mais **rien ne l'alimente jamais**. C'est cohérent avec l'instruction de la mission (« suppression du rendu et du stockage du périmètre M004 »), mais cela signifie concrètement qu'**aucune génération, même entièrement réussie, ne produit de fichier exploitable par l'écran M005 tel que spécifié** — ce n'est pas un bug de cette branche, c'est une limite de portée à lever explicitement avant d'attaquer M005.

---

## 4. Problèmes annoncés comme corrigés — vérifiés, avec preuve précise

| Annonce d'OpenCode | Statut vérifié | Preuve |
|---|---|---|
| Vraie queue BullMQ injectée dans l'API | ✅ **Confirmé réel** | `generation.module.ts` : `BullModule.registerQueue({name:'generation', ...})` ; `generation.service.ts` : `@InjectQueue('generation') private readonly generationQueue: Queue` et `this.generationQueue.add('generation', {generationId}, {jobId: generation.id, ...})`. Compile (typecheck PASS réel de la partie non bloquée par §0 — la déclaration elle-même est syntaxiquement et structurellement correcte). |
| Un seul worker | ✅ **Confirmé réel** | `apps/api/src/worker/worker.service.ts` (le second worker dupliqué) est **supprimé** du dépôt (confirmé par `git ls-files`). Seul `apps/worker/src/index.ts` subsiste. |
| Payload `{ generationId }` uniquement | ✅ **Confirmé réel et testé** | Code des deux côtés + `tests/generation.test.ts` (« accepts { generationId } only », « rejects... a sourceText that would leak »), les deux tests passent réellement. |
| Claim atomique par `updateMany` | ⚠️ **Présent mais défaillant sous retry** | Voir §3.1 : le mécanisme de claim lui-même est correct pour empêcher le double traitement **simultané**, mais casse le retry séquentiel. |
| Retry des erreurs transitoires | ❌ **Non fonctionnel** | Voir §3.1 : le code tente de le faire mais le retry n'exécute jamais réellement une seconde tentative LLM. |
| Gestion des erreurs sémantiques | ✅ **Partiellement confirmé** | Codes `LLM_ERROR`, `MALFORMED_OUTPUT`, `INVALID_RESPONSE` bien posés aux bons endroits dans le worker (lu ligne à ligne) — reste un `Error` natif côté API pour `getStatus` (§3.6). |
| Transaction de complétion (slides, statut, débit idempotent, activation) | ✅ **Confirmé réel, y compris au niveau du schéma de base** | Voir §3.2, §3.3, §3.5 — contraintes uniques vérifiées en base réelle. |
| Validation des limites de mots | ✅ **Confirmé réel et testé** | Voir §3.7 — 7 tests réels passés. |
| Suppression du rendu/stockage du périmètre M004 | ✅ **Confirmé réel** | Voir §3.11 — mais implique une incompatibilité avec M005 à traiter explicitement. |
| `OpenRouterProvider` supprimé proprement | ✅ **Confirmé réel** | `factory.ts` ne le référence plus ; `providers.ts` ne définit que `MockProvider` ; `index.ts` n'exporte plus que ce qui existe réellement. Typecheck PASS réel du paquet `llm`. |
| Auto-réexport circulaire de `renderer/index.ts` (bug trouvé dans l'audit précédent) | ✅ **Corrigé, confirmé réel** | `export { renderSlides, renderPDF } from './render'; export { LocalStorageAdapter, StorageAdapterFactory, type StorageAdapter } from './storage';` — propre. Typecheck PASS réel. |
| Bug du mock générant des slides vides sur texte court (trouvé dans l'audit précédent) | ✅ **Corrigé, confirmé réel** | `providers.ts` : `chunkWords.join(' ').trim() || 'Point important à retenir'`. Le test « slides conform to SlideSchema » passe réellement (auparavant échouait). |
| `generationId` vide renvoyé au client (trouvé dans l'audit précédent) | ✅ **Corrigé, confirmé réel** | `generation.controller.ts` : `const {generationId, status} = await this.generationService.create(...); return {status, generationId};` |
| Erreur de syntaxe (apostrophe non échappée) | ✅ **Corrigé** | Chaîne désormais en guillemets doubles. |
| Script `install` récursif dans `package.json` racine | ✅ **Corrigé** | Script supprimé. |
| Script de test racine relié à `tests/` | ✅ **Corrigé, confirmé réel** | `jest.config.js` + `pnpm test` → `jest --config jest.config.js`, exécuté réellement avec succès partiel (§2). |

## 5. Problèmes encore présents (hors ceux déjà déclarés par OpenCode)

- **P0** — Aucune route n'émet jamais de JWT ; la totalité de l'API métier est inatteignable (§3.6).
- **P0** — Le retry transitoire est structurellement cassé par le pattern de claim atomique (§3.1) — un bug **nouveau**, introduit par cette branche elle-même, pas un report d'un audit précédent.
- **P1** — Aucun reaper pour les générations bloquées (persistant depuis les audits précédents, aggravé par le P0 ci-dessus).
- **P1** — `AuthService`/`CreditsService` sont du code mort (non câblé), ce qui masque potentiellement des erreurs de typage sous la cascade Prisma (§1) tant qu'ils ne sont pas soit retirés soit réellement intégrés.
- **P2** — Compatibilité M005 à clarifier explicitement (§3.11) — pas un bug, une décision de portée à documenter.
- **P2/P3** — Risques déjà déclarés par OpenCode et confirmés réels sans changement : race `hasInProgress`/`hasCredits` (toujours un vrai TOCTOU, non testé), absence de filtre d'exception global, absence de rédaction complète des logs.

## 6. Risques classés P0 → P3

- **P0** (bloquant, doit être corrigé avant tout GO) : §3.6 (aucun JWT émis), §3.1 (retry cassé).
- **P1** (à corriger avant un déploiement réel, peut attendre un cycle très court) : absence de reaper, code mort `auth.service.ts`/`credits.service.ts`, absence de tests sur les mécanismes de concurrence/idempotence (§2).
- **P2** (à traiter avant M005 ou une charge réelle) : compatibilité M005 (§3.11), race `hasInProgress`/`hasCredits`, filtre d'exception global absent.
- **P3** (amélioration continue, non bloquant) : rédaction des logs, nettoyage des schémas `Output`/`WebhookEvent` orphelins dans Prisma.

## 7. Conditions précises avant M005

1. Corriger §3.6 : un flux d'authentification réellement câblé (au minimum `AuthModule` enregistré dans `AppModule` avec `AuthController`), sans quoi aucun scénario de M005 n'est même atteignable par un client réel.
2. Corriger §3.1 : revoir l'interaction claim atomique / retry BullMQ (remise à `QUEUED` avant `throw`, ou verrou distinct du statut) — sans cela, le taux d'échec silencieux en production sera directement proportionnel au taux d'erreurs transitoires du futur fournisseur LLM réel.
3. Ajouter au moins les tests listés en §2 pour les mécanismes de concurrence/idempotence (réalisables avec des mocks, sans base réelle) — sans eux, aucune régression future sur ces mécanismes ne sera détectée par la CI.
4. Décider et documenter explicitement le sort du rendu/stockage (§3.11) avant de commencer l'implémentation de M005, puisque M005 en dépend directement.
5. Faire tourner, une fois ces points traités, un vrai cycle `prisma generate` → `migrate deploy` → démarrage réel de l'API et du worker → tests E2E HTTP dans un environnement à réseau non restreint (la CI du dépôt, déjà configurée avec Postgres/Redis en service, convient) — c'est la seule façon de vérifier dynamiquement ce que cet audit n'a pu vérifier que statiquement ou via la structure de la base (§0).

## 8. Verdict

# **CONDITIONAL GO**

Ce n'est plus un NO-GO : la quasi-totalité des défauts bloquants des deux audits précédents (compilation impossible, aucune queue réelle, double implémentation de worker, enum incohérent, exports fantômes, auto-import circulaire, `generationId` perdu, slides vides, script d'installation récursif, absence de schéma versionné) sont **réellement corrigés**, vérifiés par lecture **et** par exécution là où l'environnement le permettait. Le travail de récupération est substantiel et honnête (OpenCode a lui-même déclaré les risques résiduels les plus importants plutôt que de les cacher).

Mais un GO plein n'est pas justifié tant que les deux points P0 ci-dessus restent ouverts : **l'application, telle que committée sur cette branche, n'expose aucun moyen de s'authentifier**, ce qui la rend fonctionnellement inutilisable de bout en bout indépendamment de la qualité du pipeline de génération ; et **le mécanisme de retry, bien que présent dans l'intention, ne retente jamais réellement rien**, ce qui est plus dangereux qu'une absence totale de retry puisqu'il masque l'échec à BullMQ et au monitoring. Les deux corrections sont ciblées et ne remettent pas en cause l'architecture adoptée par cette branche.
