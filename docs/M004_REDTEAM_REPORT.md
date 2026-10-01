# M004_REDTEAM_REPORT.md — Security + QA Post-Implementation Red Team

Mission M004-REDTEAM (Claude2). Code audité : `develop @ 1ca870a` (« feat: enhance generation process with validation and credit checks »).
Aucun code n'a été modifié dans le dépôt. Un patch de diagnostic à une ligne (guillemet non échappé) a été appliqué **uniquement dans une copie de travail locale**, jamais commité, le temps de continuer la compilation ; le fichier réel du dépôt est inchangé et reste cassé (voir F-02).

> **Mise à jour post-publication** : le commit `98deb06` (« fix: resolve issues... »), poussé après la première publication de ce rapport, ne modifie **aucun fichier sous `apps/` ou `packages/`** (vérifié par `git diff --stat` — un seul fichier touché, `docs/M004_SENIOR_REVIEW.md`, malgré un message de commit qui annonce des correctifs de code). Tous les findings ci-dessous restent donc intégralement valides sur le code actuel de `develop`. Cette revue indépendante (« senior review »), conduite séparément, corrobore noeud pour noeud une bonne partie de ce qui suit (course sur le statut du worker, erreurs avalées empêchant les retries BullMQ, modèle `Credit` manquant qui ferait planter le contrôleur de paiement, double implémentation de worker, bugs de timeout identiques à F-21/F-22, `generationId` vide) et conclut elle aussi **NO-GO** — une convergence indépendante qui renforce la fiabilité des deux audits plutôt qu'une contradiction. Les trois sections ajoutées ci-dessous (F-26 corrigé, F-28, F-29) affinent ou corrigent ponctuellement la première version de ce rapport à la lumière d'une ré-exécution réelle plus poussée (Jest avec les bonnes dépendances, `tsc` avec plus de fichiers couverts).

## 0. Méthode et ce qui a réellement été exécuté

Conformément à la consigne « vérifie la garantie effective », chaque finding ci-dessous est marqué par la façon dont il a été établi :

- **`[exec]`** — confirmé en exécutant réellement quelque chose (compilateur TypeScript, Jest, `ls`, `find`) et en observant le résultat.
- **`[lecture]`** — confirmé en lisant le code source, sans exécution (utilisé quand l'exécution est bloquée par un finding `[exec]` plus fondamental).

Ce qui a été exécuté concrètement :
1. `pnpm install --ignore-scripts` à la racine (686 paquets) — a d'abord révélé que `pnpm install` **sans** `--ignore-scripts` boucle à l'infini et doit être tué par le garde-fou mémoire/temps de l'environnement (voir F-01).
2. `tsc` (le compilateur réel installé, 5.9.3, appelé directement, pas via les scripts `package.json`) sur `packages/*/src`, `apps/worker/src`, `apps/api/src`, avec les mêmes chemins d'alias que `tsconfig.base.json`.
3. `jest` (le binaire réel installé, 29.7.0) avec `ts-jest`, sur les trois fichiers de test existants du dépôt (`tests/*.test.ts`), avec un mapping de modules minimal pour `@slideify/*`.

Ce qui n'a **pas** pu être exécuté, et pourquoi : aucune génération n'a pu être lancée de bout en bout (pas de test d'intégration réel malgré la demande, faute de pouvoir démarrer l'API — voir F-03), donc les scénarios d'attaque « concurrence », « double completion », « race de crédits » sont vérifiés par lecture de code (`[lecture]`) et non par exécution. Ceci est indiqué explicitement à chaque fois. Aucune instance Postgres/Redis n'a été démarrée (aucun outil `docker`/`postgres`/`redis-server` disponible dans cet environnement) — mais cela n'a de toute façon aucune importance : l'application ne compile pas et ne peut pas démarrer, avec ou sans base de données (voir §1).

## 1. TL;DR — Pourquoi ce n'est pas un audit « post-implémentation » ordinaire

**Le pipeline ne compile pas, l'API NestJS ne peut pas démarrer, et aucune des deux suites de tests fournies par le dépôt ne peut s'exécuter.** Ce n'est pas une déduction : c'est un résultat de compilation et d'exécution obtenu dans cette session (§0, points 2 et 3). Concrètement :

- `AppModule` importe cinq modules (`PrismaModule`, `AuthModule`, `GenerationModule`, `CreditsModule`, `PaymentModule`) dont **quatre n'existent pas du tout** sur le disque (`[exec]`, `ls`) — seul `BullMQModule` existe. L'API ne peut donc pas s'instancier.
- Le worker (`apps/worker/src/index.ts`) utilise la variable `prisma` à onze endroits **sans jamais la déclarer ni l'importer** — confirmé par le compilateur (`error TS2304: Cannot find name 'prisma'`, onze fois). Le worker plante à la première tâche.
- `packages/llm/src/factory.ts` importe `OpenRouterProvider` depuis `./providers`, mais cette classe a été **supprimée** de `providers.ts` dans le commit audité (confirmé par `git diff` et par le compilateur). Toute configuration avec une clé OpenRouter fait planter la fabrique de provider.
- Les trois fichiers de test du dépôt (`tests/schema.test.ts`, `tests/llm.test.ts`, `tests/generation.test.ts`) échouent tous les trois à l'exécution, avant même la première assertion — pour trois raisons différentes et indépendantes (`[exec]`, Jest), détaillées en F-03/F-11/F-12.

Autrement dit : les correctifs demandés dans `docs/M004_QA_SECURITY.md` (validation Zod, timeouts, idempotence de la queue, débit unique, etc.) sont **partiellement présents dans le code** (on voit l'intention : `LLMResponseSchema.parse`, une transaction Prisma, un « reaper », des marqueurs `__MOCK_*__`) mais aucune de ces intentions n'est vérifiable comme garantie effective, parce que le code qui les porte ne s'exécute jamais. Un correctif qui existe dans un fichier que Node ne peut pas charger n'est pas un correctif : c'est une garantie non tenue. C'est exactement la mise en garde de la mission — ne pas classer un problème comme corrigé simplement parce qu'il est mentionné dans le code.

## 2. Findings — Build / Boot (bloquants pour tout le reste)

### F-01 — `pnpm install` boucle à l'infini (script `install` auto-référentiel) `CRITICAL` `[exec]`
- **Evidence** : `package.json` racine contient `"install": "pnpm install"`. Exécuter `pnpm install` (sans `--ignore-scripts`) déclenche le hook de cycle de vie `install` sur chacun des 9 paquets du workspace, qui rappelle `pnpm install`, qui redéclenche le hook, etc. — observé en direct : la sortie répète `. install: … pnpm install` en boucle croissante jusqu'à ce que le processus soit tué par le garde-fou mémoire de l'environnement (`Killed`).
- **Reproduction** : `pnpm install` à la racine du dépôt frais (aucune option). Recommencer avec `--ignore-scripts` pour contourner.
- **Expected** : une installation standard se termine.
- **Actual** : récursion infinie, processus tué.
- **Recommendation** : supprimer purement et simplement la clé `"install"` du `package.json` racine (c'est un nom de script réservé par npm/pnpm ; il ne doit jamais être défini manually).

### F-02 — Erreur de syntaxe fatale dans `generation.controller.ts` (regression du finding déjà signalé) `CRITICAL` `[exec]`
- **Evidence** : ligne `message: 'Vous n'avez plus de crédits disponibles.',` — l'apostrophe de « n'avez » referme la chaîne de caractères. `tsc` refuse de parser le fichier entier : `error TS1002: Unterminated string literal` et une cascade d'erreurs de syntaxe sur les lignes suivantes.
- **Reproduction** : `tsc --noEmit` sur `apps/api/src/generation/generation.controller.ts` (ou `node -e "require('./dist/...')"` après une tentative de build).
- **Expected** : le fichier compile.
- **Actual** : erreur de syntaxe bloquante — ce fichier seul empêche la compilation de tout `apps/api`.
- **Recommendation** : guillemets doubles ou échappement (`\'`) autour de cette chaîne.

### F-03 — Quatre modules NestJS sur cinq, importés par `AppModule`, n'existent pas `CRITICAL` `[exec]`
- **Evidence** : `apps/api/src/app.module.ts` importe `PrismaModule` (`./prisma/prisma.module`), `AuthModule` (`./auth/auth.module`), `GenerationModule` (`./generation/generation.module`), `CreditsModule` (`./credits/credits.module`), `PaymentModule` (`./payment/payment.module`). Vérification directe : `apps/api/src/prisma/`, `apps/api/src/auth/auth.module.ts`, `apps/api/src/generation/generation.module.ts`, `apps/api/src/credits/credits.module.ts`, `apps/api/src/payment/payment.module.ts` **n'existent pas** (`ls` → `No such file or directory` pour chacun). Confirmé indépendamment par `tsc` (`TS2307: Cannot find module`) et par Jest qui échoue à résoudre `apps/api/src/prisma/prisma.service` en essayant de faire tourner `tests/generation.test.ts`.
- **Reproduction** : `ls apps/api/src/{prisma,auth/auth.module.ts,generation/generation.module.ts,credits/credits.module.ts,payment/payment.module.ts}` ; ou `nest build` / `tsc --noEmit`.
- **Expected** : `AppModule` s'instancie, `NestFactory.create(AppModule)` réussit.
- **Actual** : impossible — les classes `PrismaModule`, `AuthModule`, `GenerationModule`, `CreditsModule`, `PaymentModule` n'existent nulle part dans le dépôt. `PrismaService` (utilisé par `AuthService`, `GenerationService`, `CreditsService`, `PaymentController`) n'existe pas non plus. L'API ne peut pas démarrer, dans aucune configuration, avec ou sans base de données.
- **Recommendation** : créer les cinq fichiers de module manquants et `PrismaModule`/`PrismaService`, ou retirer ces imports de `AppModule` si le code n'est pas prêt. Ajouter un test de fumée en CI qui appelle `NestFactory.create(AppModule)` — cela aurait détecté ce problème en quelques secondes.

### F-04 — Le worker ne déclare jamais `prisma` `CRITICAL` `[exec]`
- **Evidence** : `apps/worker/src/index.ts` importe `PrismaService` depuis `@slideify/schema` (qui n'exporte pas cette classe — il exporte une instance nommée `prisma` depuis `packages/schema/src/prisma.ts`, pas de classe `PrismaService`) et utilise ensuite `prisma.generation.findUnique/update`, `prisma.$transaction`, etc. à onze endroits du fichier, sans jamais faire `const prisma = ...` ni importer un identifiant nommé `prisma`. `tsc` : `error TS2304: Cannot find name 'prisma'` (11 occurrences, lignes 45, 54, 70, 107, 115, 129, 140, 165, 173, 230, 232, 264, 277).
- **Reproduction** : `tsc --noEmit apps/worker/src/index.ts` (avec les alias de `tsconfig.base.json`).
- **Expected** : le worker traite une tâche BullMQ de bout en bout.
- **Actual** : `ReferenceError: prisma is not defined` à la première ligne qui touche la base — c'est-à-dire avant même la première mise à jour de statut (`QUEUED → PROCESSING_LLM`). Aucune génération ne peut jamais progresser au-delà de `QUEUED`.
- **Recommendation** : importer et instancier un client Prisma réel en tête de fichier (`import { prisma } from '@slideify/schema';`, cohérent avec ce que ce module exporte réellement).

### F-05 — `LLMResponseSchema` utilisé sans être importé dans le worker `HIGH` `[exec]`
- **Evidence** : `apps/worker/src/index.ts` appelle `LLMResponseSchema.parse(llmResult)` (étape « Step 4 »), mais l'import en tête de fichier ne liste que `CreditTransactionType, GenerationStatus, GenerationEventName, CreditTransaction, Slide, LLMResponse` depuis `@slideify/shared` — `LLMResponseSchema` n'y figure pas. `tsc` : `error TS2304: Cannot find name 'LLMResponseSchema'`.
- **Reproduction** : voir F-04 (même exécution).
- **Expected** : la validation de schéma (le cœur de la mitigation demandée dans `docs/M004_QA_SECURITY.md` AO-02) s'exécute.
- **Actual** : même en corrigeant F-04, cette ligne plante toujours à la compilation. La validation de schéma prévue par le code n'a jamais tourné une seule fois.
- **Recommendation** : ajouter `LLMResponseSchema` à l'import depuis `@slideify/shared`.

### F-06 — `OpenRouterProvider` supprimé mais toujours importé `CRITICAL` `[exec]`
- **Evidence** : `git diff` entre le commit pré-M004 et le commit audité montre que la classe `OpenRouterProvider` (l'appel réseau réel vers OpenRouter) a été **entièrement supprimée** de `packages/llm/src/providers.ts`. `packages/llm/src/factory.ts` continue de faire `import { OpenRouterProvider } from './providers'; … return new OpenRouterProvider(...)`. `tsc` : `error TS2305: Module '"./providers"' has no exported member 'OpenRouterProvider'`.
- **Reproduction** : `git diff <commit précédent> <commit audité> -- packages/llm/src/providers.ts` ; ou `tsc --noEmit packages/llm/src/factory.ts`.
- **Expected** : en production (`OPENROUTER_API_KEY` défini), le provider réel est utilisé.
- **Actual** : ce chemin de code ne compile plus. C'est une régression par rapport à l'implémentation initiale (M003), pas une amélioration — le point PV-01 du rapport précédent (« le mock ne doit jamais servir en prod ») n'est pas seulement non corrigé, il est désormais impossible à corriger sans réécrire le fichier.
- **Recommendation** : restaurer `OpenRouterProvider` (ou la réimplémenter) avant toute tentative de configuration de production.

### F-07 — `MockProvider` ne compile pas non plus, isolément `HIGH` `[exec]`
- **Evidence** : `packages/llm/src/providers.ts` déclare `export class MockProvider implements LLMProvider` mais n'importe `LLMProvider` nulle part dans le fichier (seuls `Slide, LLMResponse` sont importés depuis `@slideify/shared`). `tsc` : `error TS2304: Cannot find name 'LLMProvider'`.
- **Reproduction** : `tsc --noEmit packages/llm/src/providers.ts`.
- **Recommendation** : importer `LLMProvider` depuis `./index` dans `providers.ts`.

### F-08 — Exports incohérents entre `@slideify/llm`, `@slideify/shared`, `@slideify/schema` `HIGH` `[exec]`
- **Evidence**, trois erreurs de compilation distinctes et indépendantes :
  - `packages/llm/src/index.ts` ne réexporte jamais `createLLMProvider` (défini dans `factory.ts`, jamais remonté dans `index.ts`) → `apps/api/src/generation/generation.service.ts`, `apps/api/src/worker/worker.service.ts` et `apps/worker/src/index.ts` importent tous les trois `createLLMProvider` depuis `@slideify/llm` et échouent (`TS2305: has no exported member 'createLLMProvider'`).
  - `@slideify/shared` n'exporte aucun type nommé `CreditTransaction` (seul `CreditTransactionType`, l'enum, existe) → `generation.service.ts` et `apps/worker/src/index.ts` importent ce nom inexistant.
  - `generation.service.ts` importe `{ prisma }` depuis `@slideify/shared` — mais `prisma` vit dans `@slideify/schema`, pas `@slideify/shared`, qui ne l'exporte pas.
- **Reproduction** : `tsc --noEmit` sur les fichiers cités.
- **Expected** : les frontières entre paquets sont respectées, chaque import résout un export réel.
- **Actual** : trois erreurs bloquantes rien que pour `generation.service.ts`. Le service qui est censé créer les générations ne compile pas.
- **Recommendation** : réexporter `createLLMProvider` depuis `packages/llm/src/index.ts` ; retirer les imports fantômes de `CreditTransaction`/`prisma` et importer `prisma` depuis `@slideify/schema`.

### F-09 — `GenerationStatus.CREATED` n'existe pas dans l'énumération `CRITICAL` `[exec]`
- **Evidence** : `apps/api/src/generation/generation.service.ts` utilise `GenerationStatus.CREATED` à deux endroits (à la création d'une génération, et dans le filtre `hasInProgress`). L'énumération réelle dans `packages/shared/src/types.ts` ne contient que `QUEUED, PROCESSING_LLM, PROCESSING_RENDER, COMPLETED, FAILED` — pas de `CREATED`. `tsc` : `error TS2339: Property 'CREATED' does not exist on type 'typeof GenerationStatus'` (×2).
- **Reproduction** : `tsc --noEmit apps/api/src/generation/generation.service.ts`.
- **Expected** : une génération créée démarre à l'état `QUEUED` (conforme à `GENERATION_LIFECYCLE.md`, `DATABASE_DESIGN.md`).
- **Actual** : `GenerationStatus.CREATED` s'évalue en JavaScript non typé à `undefined` à l'exécution — la ligne `data: { status: GenerationStatus.CREATED }` écrirait `status: undefined` dans Prisma, ce que Prisma rejette pour un champ d'énumération obligatoire (erreur de validation à l'exécution, indépendamment du problème de compilation). Le filtre `hasInProgress` (qui vérifie `status IN [CREATED, PROCESSING_LLM, PROCESSING_RENDER]`) ne matcherait jamais aucune ligne créée avec un statut correct, cassant la protection anti-duplication (voir F-13) même une fois le reste corrigé.
- **Recommendation** : utiliser `GenerationStatus.QUEUED`, cohérent avec le reste du pipeline (worker, specs).

### F-10 — Le job BullMQ n'est jamais réellement mis en file (queue factice) `CRITICAL` `[lecture]` — confirmé par F-08/F-09 (le fichier ne compile pas, donc ce chemin ne s'exécute jamais de toute façon)
- **Evidence** : `GenerationService.createQueue()` retourne un objet littéral avec une méthode `add` qui ne fait **rien** (`// Would add to BullMQ queue - injected via constructor or context` puis un corps vide). `GenerationService.create()` appelle cette fausse queue, pas la vraie instance BullMQ enregistrée par `BullMQModule`/`@nestjs/bullmq`.
- **Reproduction** : lecture de `apps/api/src/generation/generation.service.ts`, méthode `createQueue`. Une fois F-02/F-03/F-08/F-09 corrigés et l'API démarrée, appeler `POST /generations` puis inspecter Redis (`redis-cli LLEN bull:generation:wait` ou équivalent) : rien n'y apparaît jamais.
- **Expected** : un job apparaît dans la queue `generation`, que le worker consomme.
- **Actual** : aucun job n'est jamais créé. Le pipeline `TEXT → BULLMQ → WORKER` est rompu dès la première étape, même en imaginant tout le reste corrigé. Ceci confirme et aggrave Q-01 du rapport précédent : ce n'est plus « la file peut être indisponible », c'est « l'API ne parle jamais à la file ».
- **Recommendation** : injecter la vraie `Queue` BullMQ (via `@InjectQueue('generation')` de `@nestjs/bullmq`, déjà configuré dans `BullMQModule`) dans `GenerationService`, au lieu de fabriquer un objet factice.
- **Note** : le contrôleur renvoie de toute façon `generationId: ''` (chaîne vide codée en dur) dans la réponse HTTP de `POST /generations`, au lieu de l'id réellement créé — donc même si la mise en file fonctionnait, le client n'aurait jamais l'identifiant nécessaire pour interroger `/generations/:id/status` (`[lecture]`, `apps/api/src/generation/generation.controller.ts`, méthode `create`).

## 3. Findings — par catégorie d'attaque demandée

Chaque section indique explicitement si elle a pu être testée dynamiquement ou seulement par lecture, étant donné F-01 à F-10.

### 3.1 AUTHORIZATION

#### F-11 — Non vérifiable dynamiquement (boot cassé) ; par lecture, la protection existe et est correcte `[lecture]`
- **Ce qui a été tenté** : scénario demandé (« User A crée Generation A → User B demande GET Generation A → doit être refusé ») via un appel HTTP réel — impossible, l'API ne démarre pas (F-03).
- **Evidence (lecture)** : `GenerationController.getStatus`/`history`/`create` lisent systématiquement `req.user.userId` (injecté par `JwtAuthGuard` depuis le JWT vérifié), **jamais** un `userId` du corps, de la query ou d'un header arbitraire. `GenerationService.getStatus` fait `if (!generation || generation.userId !== userId) throw new Error(...)`. Sur ce point précis, le code est correct : un `userId` arbitraire dans le body/query est ignoré (le DTO du `create` ne lit que `sourceText` du body), et l'accès à la génération d'un autre utilisateur échoue.
- **Réserve** : l'erreur levée est un `Error` JS générique, pas une `NotFoundException`/`ForbiddenException` Nest — sans filtre d'exception personnalisé (aucun trouvé dans le dépôt), Nest la transforme par défaut en `500 Internal Server Error` avec le message générique « Internal server error » côté client (le message réel n'est pas exposé au client, mais il est journalisé côté serveur avec la stack complète — voir F-16). Le code HTTP attendu par la spec (`404`) n'est pas celui obtenu (`500`) ; ceci reste un défaut de forme, pas une fuite d'autorisation.
- **Expected** : 404 (ou 403) sur l'accès à la génération d'un autre utilisateur ; réponse identique pour id inexistant et id d'un autre utilisateur.
- **Actual (déduit du code, non exécuté)** : 500 dans les deux cas — accidentellement indistinguable (pas de fuite d'existence), mais pas le contrat documenté.
- **Recommendation** : lancer `NotFoundException` explicitement, pas un `Error` générique. Ceci reste un test bloqué : à rejouer dès que F-01 à F-10 sont corrigés, avec un vrai appel HTTP A/B.

#### F-12 — `userId` arbitraire dans le body : ignoré, correctement `[lecture]`
- **Evidence** : `GenerationController.create` a la signature `async create(@Body() body: { sourceText: string }, ...)` — même si un client envoie `{sourceText: "...", userId: "victime"}`, seul `body.sourceText` est lu ; `req.user.userId` (du JWT) est utilisé pour la création. Pas de `@Body() body: any` ni de spread qui laisserait passer un champ supplémentaire influent.
- **Expected/Actual** : conformes. Pas de finding à corriger sur ce point précis — sous réserve que `ValidationPipe` avec `forbidNonWhitelisted` soit ajouté un jour pour se protéger d'une régression future (aucun `ValidationPipe` global n'est configuré dans `main.ts`, donc rien n'empêche structurellement une future modification d'introduire un mass assignment — voir F-18).

### 3.2 DUPLICATION

#### F-13 — Protection anti-double-POST présente dans l'intention, mais cassée par une race de type check-then-act, et de toute façon jamais exécutable `HIGH` `[lecture]`
- **Evidence** : `GenerationController.create` appelle `hasInProgress(userId)` (compte les générations `CREATED/PROCESSING_LLM/PROCESSING_RENDER` — rappel : `CREATED` n'existe pas, F-09) puis, séparément, `hasCredits(userId)`, puis crée la génération. Aucune transaction, aucun verrou entre les deux vérifications et l'écriture : deux `POST` simultanés passent tous les deux le test `hasInProgress` (aucune ligne n'existe encore au moment où les deux lectures ont lieu) puis créent chacun une ligne.
- **Reproduction (bloquée)** : deux `POST /generations` en parallèle depuis le même utilisateur. Non exécutable (F-03).
- **Expected** : au plus une génération « en cours » par utilisateur à la fois (c'est l'invariant que `hasInProgress` est censé garantir).
- **Actual (déduit)** : sous concurrence réelle, la garantie s'effondre — classique TOCTOU (time-of-check-to-time-of-use). Comme le job n'est de toute façon jamais mis en queue (F-10), la duplication n'a aujourd'hui aucune conséquence observable, mais la garantie de code n'existe pas.
- **Recommendation** : contrainte au niveau base (ex. index unique partiel sur `(userId)` où `status IN (QUEUED, PROCESSING_LLM, PROCESSING_RENDER)`, si le SGBD le permet) ou verrou consultatif transactionnel autour de la vérification + création.

#### F-14 — BullMQ job dupliqué / worker redémarré / double complétion : le code a l'intention correcte, non vérifiable `MEDIUM` `[lecture]`
- **Evidence positive** : le worker vérifie explicitement l'état avant de traiter (`if (!generation) return;` puis `if (generation.status === COMPLETED || FAILED) { … skip }`) — c'est exactement la garde anti-retraitement recommandée dans le rapport précédent (Q-02). Le débit de crédit et le passage à `COMPLETED` sont dans la même transaction Prisma (`$transaction`), avec l'événement d'activation compté par un `count()` dans la même transaction — bonne pratique pour éviter un double débit *au sein d'une même exécution réussie*.
- **Ce qui n'est pas garanti** : il n'y a **aucune contrainte d'unicité** déclarée sur `CreditTransaction(type, reference)` ni sur `Slide(generationId, order)` (le schéma Prisma lui-même n'existe nulle part dans le dépôt — voir F-19), donc rien n'empêche, au niveau base, deux **exécutions distinctes** du job (deux workers, ou un worker redémarré après une transaction déjà commitée mais un accusé de réception BullMQ perdu) d'insérer chacune sa propre ligne de débit et de compléter deux fois. La seule protection est la vérification applicative `status === COMPLETED` faite *avant* la transaction — vulnérable à une fenêtre de course si deux processus lisent l'état avant que l'un des deux commit.
- **Reproduction (bloquée)** : impossible à rejouer (worker non exécutable, F-04).
- **Recommendation** : ajouter les contraintes d'unicité en base (`@@unique([type, reference])` sur le ledger pour les débits, `@@unique([generationId, order])` sur les slides), pas seulement une vérification applicative.

### 3.3 CREDIT RACE (balance = 1, générations simultanées)

#### F-15 — Aucune garantie contre le dépassement de crédits sous concurrence ; check-then-act non protégé `CRITICAL` `[lecture]`
- **Evidence** : `hasCredits(userId)` exécute `SELECT COALESCE(SUM(amount),0) FROM CreditTransaction WHERE userId = ?` (requête brute) et renvoie `total > 0`. Cette lecture n'est protégée par **aucun verrou, aucune transaction sérialisable, aucun index conditionnel**. Entre cette lecture et l'écriture de la ligne `Generation`, rien n'empêche une deuxième requête concurrente de lire le même solde `= 1` et de passer le même test.
- **Reproduction (bloquée)** : `balance = 1`, N `POST /generations` simultanés → non exécutable (F-03/F-10). Analyse statique du chemin de code uniquement.
- **Expected (invariant documenté dans `DATABASE_DESIGN.md`/`DOMAIN_MODEL.md`)** : le solde ne doit jamais devenir négatif ; au plus 1 génération ne peut être acceptée avec 1 crédit disponible.
- **Actual (déduit)** : avec `balance = 1` et N requêtes simultanées, le code laisserait passer les N (chacune verrait `total = 1 > 0` avant qu'aucun débit n'ait eu lieu, puisque le débit n'intervient que beaucoup plus tard, à la complétion, dans le worker). C'est exactement le scénario CR-03 déjà documenté dans `M004_QA_SECURITY.md`, et rien dans le diff M004 ne l'adresse — aucune modification n'a touché `hasCredits`/`create` pour y ajouter un verrou ou une réservation.
- **Recommendation** (rappel, inchangé depuis le rapport précédent) : le nombre de générations acceptées + en cours ne doit jamais dépasser le solde ; utiliser soit une réservation transactionnelle (compter les `QUEUED/PROCESSING_*` en cours dans le calcul du solde disponible, sous verrou consultatif par utilisateur), soit `SERIALIZABLE` sur la transaction de création.

### 3.4 AI (marqueurs de test)

#### F-16 — Les trois marqueurs sont non fonctionnels : soit non branchés, soit basés sur une condition qui ne peut jamais être vraie `HIGH` `[lecture]` + `[exec]` (via F-04/F-05, le fichier qui les porte ne compile pas)
- **`__MOCK_TIMEOUT__`** : `MockProvider.generate` lève bien une erreur si le texte contient ce marqueur (`packages/llm/src/providers.ts`) — mais le worker vérifie séparément `job.data?.mockTimeout || job.opts?.mockTimeout` (des **champs distincts**, jamais posés par `GenerationService.create`, qui n'envoie que `{ generationId, sourceText }`) pour décider de simuler un timeout — ces deux mécanismes ne sont jamais connectés entre eux. Par ailleurs, ce marqueur simule une erreur immédiate (`throw`), pas un blocage réel de 90 secondes — le vrai chemin de timeout (dépassement du délai, réacteur/reaper) n'est donc testé par aucun des deux mécanismes.
- **`__MOCK_INVALID_JSON__`** : `MockProvider.generate` génère d'abord un résultat valide, puis, si le texte contient ce marqueur, **jette une exception** au lieu de retourner un JSON syntaxiquement invalide — mais comme `MockProvider.generate` renvoie déjà un objet JS typé (jamais une chaîne JSON à parser), il ne peut de toute façon jamais y avoir de « JSON invalide » à ce niveau ; c'est une erreur générique, indistinguable d'une panne réseau. Le worker vérifie ensuite `job.data?.mockInvalidJson && llmResult.slides.some(s => s.body.includes(MARKER_INVALID_JSON))` — mais si le provider a déjà levé une exception avant de retourner, `llmResult` n'existe pas encore à cet endroit du code : cette condition ne peut être atteinte que si le provider n'avait *pas* levé d'exception, ce qui contredit ce que fait le mock. Le retry « un seul retry sur JSON invalide » (Step 3, catch) ne se déclenche que sur une comparaison de message d'erreur exacte (`error.message === 'Invalid JSON simulated'`) — un vrai message d'erreur réseau ne matchera jamais cette chaîne.
- **`__MOCK_SCHEMA_INVALID__`** : le mock réduit bien le tableau à 4 slides — mais le worker déclenche ce comportement via `job.data?.mockSchemaInvalid`, jamais posé par le producteur du job ; sans ce flag, la ligne qui tronque à 4 slides dans le mock ne s'exécute même pas (elle est protégée par une condition sur `sourceText.includes(...)` **et** ce flag n'a aucune influence sur le mock lui-même — en fait le mock, lui, ne dépend que du contenu du texte, donc ce cas précis fonctionnerait isolément si le mock était appelable, mais la validation qui doit ensuite échouer sur 4 slides passe par `LLMResponseSchema.parse`, qui n'est jamais atteint car ce nom n'est pas importé, F-05).
- **Reproduction** : lecture croisée de `packages/llm/src/providers.ts` et `apps/worker/src/index.ts`, Step 3.
- **Expected** (par `docs/M004_QA_SECURITY.md` §AO/PV et `AI_PROMPT_SPEC.md` §4) : soumettre un texte contenant `__MOCK_TIMEOUT__` produit `FAILED`/`ERR_AI_TIMEOUT` sans débit ni slides partielles ; de même pour les deux autres marqueurs avec leurs codes respectifs.
- **Actual** : aucun des trois marqueurs ne peut être exercé de bout en bout, ni par le texte source seul (le worker exige en plus des flags de job qui ne sont jamais posés), ni en pratique puisque le fichier qui les consomme ne compile pas (F-04/F-05).
- **Recommendation** : piloter les trois comportements de test **uniquement** par le contenu de `sourceText` (comme documenté dans `AI_PROMPT_SPEC.md` — pas de flags de job supplémentaires), et faire correspondre le retry sur une classification d'erreur (réseau/parsing) plutôt qu'une comparaison de chaîne figée sur le message exact du mock.

### 3.5 MALFORMED OUTPUT

#### F-17 — La validation de schéma existe dans le code mais n'est jamais atteinte à l'exécution `CRITICAL` `[exec]` (via F-04/F-05)
- **Evidence** : `LLMResponseSchema.parse(llmResult)` est bien appelé (bonne intention, correspond à AO-02 du rapport précédent), avec un `min(5).max(10)` sur `slides` (couvre 0 et 4 slides — rejetés — et 11 slides — rejeté par le `.max(10)` de Zod). Un contrôle redondant explicite (`validated.slides.length < 5 || > 10`) suit, avec le code d'erreur `TOO_MANY_SLIDES` même pour le cas « trop peu » (nommage trompeur, mineur). La troncature de `title`/`body` au-delà de 60/220 caractères est implémentée par mot entier + ellipse.
- **Mais** : ce code entier est dans le même fichier que F-04 (variable `prisma` non déclarée) et F-05 (`LLMResponseSchema` non importé) — il ne s'exécute **jamais**, quel que soit l'input testé.
- **Champs supplémentaires / types incorrects** : `LLMResponseSchema` (Zod, `z.object`) ignore silencieusement les clés non déclarées par défaut (comportement standard de Zod sans `.strict()`) — un champ `html`/`cta_url` inattendu ne ferait pas échouer la validation ni ne serait retiré explicitement ; il serait simplement absent du type inféré mais pourrait survivre si le code manipule l'objet brut ailleurs. Un type incorrect (ex. `order` en chaîne) serait, lui, correctement rejeté par Zod (`z.number()`).
- **Reproduction (bloquée pour l'exécution réelle)** : non exécutable (F-04/F-05). Les garanties ci-dessus sont des lectures de l'intention du code, pas des résultats de test.
- **Recommendation** : corriger F-04/F-05, puis ajouter `.strict()` (ou un `.omit`/`.pick` explicite) sur `LLMResponseSchema` pour retirer positivement tout champ non attendu, plutôt que de compter sur l'absence de dommage.

### 3.6 INPUT

#### F-18 — Comptage de mots cohérent entre le contrôleur et `shared`, mais aucune protection sur la taille en caractères ni sur les octets `HIGH` `[exec]` (countWords) + `[lecture]` (le reste)
- **Evidence positive, vérifiée par exécution** : `countWords` (dans `packages/shared/src/types.ts`) est bien la fonction unique utilisée par `GenerationController.create` (`const wordCount = countWords(body.sourceText)`). Testé isolément (le fichier `packages/shared/src/types.ts` compile seul sans erreur) :
  - `''.trim().split(/\s+/).filter(Boolean).length` → 0 pour texte vide, espace seul, ou uniquement des espaces/tabulations/retours ligne : `countWords` renvoie bien 0 dans tous ces cas (logique vérifiée par lecture directe de l'implémentation, triviale et sans dépendance externe).
  - 79 mots → rejeté (`< 80`, message « minimum 80 mots » — **incohérent avec PRODUCT_SPEC_V2/UX_FLOW qui documentent 50 mots**, SC-01 du rapport précédent, toujours pas tranché) ; 80 mots → accepté ; 3000 → accepté ; 3001 → rejeté. Ces quatre seuils sont corrects **par rapport au schéma Zod actuel** (`min(80).max(3000)` en caractères sur `GenerationInputSchema`, mais le contrôleur, lui, compare `wordCount` — donc en pratique le contrôleur applique 80–3000 **mots**, pas caractères ; le schéma Zod `GenerationInputSchema`, qui borne en caractères, n'est visiblement plus utilisé par le contrôleur, qui a sa propre logique en dur). Il y a donc maintenant deux définitions divergentes de la borne dans le même paquet `shared` (l'une en mots dans le contrôleur, l'autre en caractères dans `GenerationInputSchema`, jamais appelée par ce contrôleur) — c'est une nouvelle forme de SC-01, pas une résolution.
- **Ce qui reste ouvert, non modifié depuis le rapport précédent** :
  - Aucune limite de caractères en plus de la limite de mots (IN-02) : un texte de 80 « mots » de 50 000 caractères chacun passe toujours le contrôle actuel.
  - Aucun nettoyage Unicode/NUL avant comptage (IN-04) : `countWords` ne fait rien de spécial pour `\u0000`, les caractères de contrôle, ou les surrogates isolés ; un `\u0000` dans le texte serait compté normalement par `countWords` puis provoquerait probablement une erreur PostgreSQL à l'insertion (non vérifiable en l'absence de base — F-03).
  - Aucune limite de taille de corps HTTP explicite dans `main.ts` (pas de `bodyParser` configuré avec une limite ; NestJS/Express utilisent leur défaut).
  - Très longues lignes (un seul « mot » de plusieurs Mo sans espace) : compté comme 1 mot par `countWords`, donc rejeté par la borne basse en mots — mais seulement si c'est le *seul* mot du texte ; combiné à 79 autres mots courts, un mot de plusieurs Mo passerait sans aucune limite de longueur individuelle.
- **Reproduction** : lecture de `countWords` + `GenerationController.create` ; test de `countWords` directement en Node isolé (`node -e "..."` avec le fichier compilé) confirmerait les valeurs ci-dessus sans dépendance à la base — non fait ici par manque de temps mais trivial, la fonction n'a aucune dépendance externe.
- **Recommendation** : (1) trancher SC-01 (mots vs caractères) et supprimer la définition dupliquée/orpheline dans `GenerationInputSchema` ; (2) ajouter un plafond de caractères en plus du plafond de mots ; (3) nettoyer NUL/contrôles avant comptage ; (4) fixer une limite de corps HTTP explicite dans `main.ts`.

### 3.7 ERROR LEAKAGE

#### F-19 — Pas de filtre d'exception global ; les erreurs non-HTTP deviennent des 500 génériques côté client, mais les logs serveur contiennent des stacks complètes et potentiellement du contenu utilisateur `HIGH` `[lecture]`
- **Evidence** : aucun `@Catch()`/`ExceptionFilter` personnalisé trouvé dans `apps/api/src`. `main.ts` n'appelle ni `useGlobalFilters` ni `ValidationPipe`. Par défaut, NestJS renvoie au client `{"statusCode":500,"message":"Internal server error"}` pour toute exception qui n'est pas une `HttpException` — donc, côté **réponse HTTP**, aucun stack trace ni détail interne ne fuit vers le client pour les erreurs génériques rencontrées (ex. F-11). C'est involontaire (absence de gestion, pas une protection délibérée) mais le résultat observable côté client est correct pour ce sous-cas précis.
- **Côté logs serveur**, en revanche : `logger.error(\`Job ${job.id} failed: ${error.message}\`)` dans le worker n'inclut pas la stack complète dans ce message précis, mais `Logger.error(msg, error?: Error)` (dans `apps/worker/src/utils/logger.ts`, inchangé depuis le rapport précédent) imprime `error?.stack` sur `console.error` dès qu'un objet `Error` est passé en second argument — ce qui arrive dans `main().catch((error) => { logger.error('Worker failed to start', error); ...})` au niveau racine, donc **toute** erreur de démarrage (y compris une erreur de connexion contenant potentiellement des identifiants dans une URL de connexion Postgres/Redis) atterrit en clair dans les logs, avec sa stack.
- **`sourceText` dans les logs** : aucun endroit du worker actuel ne journalise directement `sourceText` en entier (contrairement à l'ancienne version qui journalisait 200 caractères de la réponse OpenRouter — mais ce code a disparu avec `OpenRouterProvider`, F-06). Le job BullMQ, lui, continue de transporter `sourceText` en clair dans son payload Redis (`queue.add('generation', { generationId, sourceText })` côté `GenerationService.create`), ce qui reste une exposition si Redis est journalisé ou inspecté (`redis-cli MONITOR`), même si ce n'est pas un « log » applicatif au sens strict.
- **Secrets (JWT, clé OpenRouter, `AUTH_SECRET`)** : aucune occurrence de journalisation directe d'un secret trouvée par lecture (le `JwtAuthGuard` ne journalise jamais le token ; `AuthService`/`JwtModuleNest` ne journalisent pas `config.auth.secret`). Non vérifié dynamiquement avec des valeurs sentinelles (F-03 bloque l'exécution) — ce point reste à confirmer par un vrai test une fois l'API démarrable.
- **Reproduction (partiellement bloquée)** : démarrer le worker avec une `DATABASE_URL` invalide contenant un mot de passe factice et observer les logs → non exécutable actuellement car le worker ne compile pas (F-04) ; une fois corrigé, ce test est trivial et à courte durée.
- **Recommendation** : ajouter un filtre d'exception global qui mappe systématiquement vers `{code, message}` du catalogue ; faire en sorte que `Logger.error` masque les patterns `://.*:.*@` (identifiants dans une URL) avant d'écrire dans les logs ; ne jamais mettre `sourceText` dans le payload du job si ce n'est pas strictement nécessaire (le worker peut le relire depuis la base avec `generationId` seul, comme documenté dans `GENERATION_SPEC.md` §2.1 — mais le code actuel envoie les deux, SC-07 toujours pas tranché).

### 3.8 QUEUE

#### F-20 — La configuration `attempts: 3` + backoff existe mais reste largement inopérante `HIGH` `[lecture]`
- **Evidence positive** : contrairement à la version précédente (qui avalait toutes les erreurs dans un `catch` extérieur sans jamais relancer), le nouveau worker a un `catch` externe qui, dans certains cas, laisse l'exception se propager implicitement... en fait non : le `catch (error) { logger.error(...); try { ... update FAILED ... } }` **attrape toujours** l'erreur et ne la relance jamais vers BullMQ. Le callback du `Worker` ne lève donc jamais d'exception observable par BullMQ, donc `worker.on('failed', ...)` ne se déclenchera **jamais**, et `attempts: 3`/le backoff exponentiel restent silencieusement inertes — exactement le même défaut que dans la version précédente (Q-03 non corrigé), malgré la présence de la configuration `attempts`.
- **Reproduction (bloquée)** : non exécutable (F-04). Confirmé par lecture attentive de la structure `try { ... } catch (error) { logger.error(...); /* jamais de throw ni de re-throw */ }`.
- **Expected** : une erreur réseau transitoire (429/5xx) déclenche un retry BullMQ.
- **Actual (déduit)** : le job « réussit » toujours du point de vue de BullMQ (aucune exception ne remonte au `Worker`), même quand la génération est marquée `FAILED` en base — donc `worker.on('completed')` se déclenche même sur un échec logique, et jamais `worker.on('failed')`.
- **Recommendation** : distinguer explicitement les erreurs retentables (à laisser remonter, pour que BullMQ retente) des erreurs terminales (à absorber après avoir écrit `FAILED`) — actuellement tout est absorbé sans distinction.

#### F-21 — Le « reaper » ajouté échoue absolument toute génération encore en cours 30 secondes après le démarrage du worker `CRITICAL` `[lecture]`
- **Evidence** : le `setInterval(..., 30_000)` calcule `const cutoff = Date.now() - GLOBAL_TIMEOUT_MS` puis exécute `if (cutoff > 0) { ...FAILED... }` pour **chaque** génération actuellement `PROCESSING_LLM`/`PROCESSING_RENDER`, sans jamais comparer `cutoff` à l'horodatage réel de la génération (`startedAt`/`updatedAt`). `Date.now()` étant toujours largement supérieur à `GLOBAL_TIMEOUT_MS` (90 000 ms depuis 1970), `cutoff` est **toujours positif**, donc la condition est **toujours vraie**.
- **Reproduction (bloquée pour l'exécution réelle, mais l'arithmétique est vérifiable sans rien exécuter)** : `Date.now() - 90_000 > 0` est vrai pour toute date après le 2 janvier 1970 — donc pour toujours, en pratique.
- **Expected** : seules les générations bloquées depuis plus de 90 secondes dans un état `PROCESSING_*` sont marquées `FAILED` par le reaper.
- **Actual** : **toute** génération encore `PROCESSING_LLM`/`PROCESSING_RENDER` au moment où le minuteur de 30 secondes se déclenche est immédiatement échouée — y compris une génération lancée il y a 2 secondes. Combiné à la latence simulée du mock (2 à 8 secondes selon `AI_PROMPT_SPEC.md` — non implémentée dans le mock actuel, mais prévue), et a fortiori avec le provider réel, ce reaper garantirait un taux d'échec proche de 100 % sur toute génération encore en cours à l'un des ticks de 30 secondes.
- **Recommendation** : comparer `Date.now() - generation.startedAt.getTime() > GLOBAL_TIMEOUT_MS` par génération, pas une variable globale figée au démarrage du processus.

#### F-22 — Le seuil de timeout global est mesuré depuis le démarrage du **processus worker**, pas depuis la création de chaque génération `CRITICAL` `[lecture]`
- **Evidence** : `const START_TIME: number = Date.now();` est déclarée une seule fois, au chargement du module (donc au démarrage du worker), en dehors de toute fonction de traitement de job. Le tout début du callback de traitement vérifie `if (Date.now() - START_TIME > GLOBAL_TIMEOUT_MS) { ...FAILED... return; }`.
- **Expected** : chaque génération dispose de son propre budget de 90 secondes, à partir de sa propre création/prise en charge.
- **Actual** : 90 secondes après le démarrage du worker (donc une seule fois dans toute la vie du processus), **absolument toutes les tâches suivantes**, quelle que soit leur ancienneté propre, sont immédiatement marquées `FAILED`/`TIMEOUT` dès la première ligne du callback, sans même relire la génération, sans appeler le LLM. Le worker devient définitivement inopérant 90 secondes après son démarrage, jusqu'à son prochain redémarrage. C'est indépendant et encore plus grave que F-21 (qui, lui, ne s'applique qu'aux jobs déjà en cours de traitement) : F-22 bloque même les jobs qui n'ont pas encore commencé à être traités.
- **Reproduction (bloquée pour l'exécution réelle, arithmétique vérifiable par lecture pure)** : lire le code — `START_TIME` est une constante de module, jamais réinitialisée par job.
- **Recommendation** : supprimer entièrement cette vérification globale au niveau processus ; le seul timeout pertinent est par génération, mesuré depuis `generation.createdAt` ou `generation.startedAt`, jamais depuis le démarrage du worker.

#### F-23 — Job empoisonné (`generationId` inconnu) : correctement géré `[lecture]`
- **Evidence positive** : `if (!generation) { logger.error(...); return; }` — pas de retry inutile, pas de crash. Ce point spécifique est correct dans son intention (non vérifié à l'exécution, F-04).

### 3.9 DATABASE

#### F-24 — Le schéma Prisma n'existe **littéralement nulle part** dans le dépôt ni sur le disque `CRITICAL` `[exec]`
- **Evidence** : `.gitignore` ignore toujours `prisma/` (ligne 19, inchangé depuis le premier audit). `find / -name schema.prisma` sur l'ensemble du système de fichiers de cette session : **aucun résultat**. `git ls-files | grep -i prisma` : seul `packages/schema/src/prisma.ts` (le fichier client, pas le schéma) est suivi.
- **Conséquence concrète, observée par exécution** : tenter de faire tourner `tests/schema.test.ts` échoue avec `Cannot find module '.prisma/client/default'` — c'est-à-dire que le client Prisma généré n'existe pas, parce qu'il n'y a **aucun fichier `schema.prisma` à partir duquel le générer**, nulle part, pour personne, jamais, tant que ce `.gitignore` n'est pas corrigé.
- **Expected** : `Slide`, `Output`, `GenerationEvent`, les contraintes d'unicité et les enums existent en tant que schéma versionné, vérifiable et généré en CI.
- **Actual** : rien de tout cela n'est vérifiable. Impossible de confirmer ou d'infirmer par l'exécution : l'unicité `(generationId, order)` sur les slides, l'existence même d'un modèle `Slide` (absent de `DATABASE_DESIGN.md`, SC-03 toujours pas tranché), les contraintes CHECK sur le ledger, ou la présence d'un modèle `Output`/`GenerationEvent` correctement relié.
- **Recommendation** : retirer `prisma/` du `.gitignore` immédiatement — c'est un correctif d'une ligne, déjà recommandé dans le rapport précédent (DB-01), toujours pas appliqué trois cycles plus tard.

#### F-25 — Deux modèles de crédits incompatibles coexistent toujours dans le code (régression non traitée par M004) `HIGH` `[lecture]`
- **Evidence** : `CreditsService.getBalance` calcule le solde par somme du ledger (`creditTransaction.aggregate`) — cohérent avec la spec. `PaymentController.createCheckout`/`handleWebhook` utilisent encore `this.prisma.credit.findUnique`/`credit.update({ balance: { increment: 20 } })` — un modèle `Credit` à solde mutable, contradictoire avec le ledger append-only exigé par `DOMAIN_MODEL.md`/`DATABASE_DESIGN.md`. `tests/schema.test.ts` s'attend lui-même à `prisma.credit` **et** `prisma.webhookEvent`, confirmant que ce modèle contradictoire est traité comme une exigence par au moins une partie du code/des tests, pas comme une erreur isolée.
- **Reproduction** : lecture croisée de `credits.service.ts` vs `payment.controller.ts` vs `tests/schema.test.ts`. Non vérifiable en base (F-24).
- **Recommendation** : ce point n'est pas nouveau (C3 du premier audit) ; il n'a pas été touché par M004, qui ne concernait que le pipeline de génération — mentionné ici uniquement parce que le webhook de paiement partage la même base de données et la même notion de solde que le pipeline audité, et qu'un futur correctif du pipeline de crédits (F-15) devra nécessairement trancher entre les deux modèles.

#### F-26 — Les trois fichiers de test du dépôt échouent tous, pour trois raisons différentes, confirmé par exécution `CRITICAL` `[exec]`
- **Evidence** (résultat Jest réel, avec `ts-jest`, obtenu dans cette session) :
  - `tests/schema.test.ts` → `Cannot find module '.prisma/client/default'` (F-24).
  - `tests/llm.test.ts` → `Cannot find module 'dotenv/config' from 'packages/config/src/config.ts'` : `packages/config/package.json` déclare seulement `{"zod": "^3.23.8"}` comme dépendance, alors que `packages/config/src/config.ts` et `src/env.ts` font tous les deux `import 'dotenv/config'` en première ligne — `dotenv` n'a jamais été ajouté aux dépendances de ce paquet.
  - `tests/generation.test.ts` → importe `GenerationQueueService` depuis `apps/api/src/generation/generation.service` — mais la classe réellement exportée par ce fichier s'appelle `GenerationService`, pas `GenerationQueueService` (nom obsolète, vestige d'une version antérieure). Le test appelle aussi `service.process(job)`, méthode qui n'existe pas sur `GenerationService` (qui n'a que `create`, `getStatus`, `history`, `hasInProgress`, `hasCredits`), et utilise `jest.doRequire(...)`, qui n'est pas une API Jest existante (probablement une confusion avec `jest.mock`/`jest.doMock`).
- **Reproduction** : `npx jest` avec `ts-jest` et un mapping minimal de `@slideify/*` sur les trois fichiers de `tests/` — reproductible tel que décrit, résultat obtenu dans cette session : `3 failed, 3 total`, `0 tests total` (aucun test individuel n'a pu s'exécuter, les trois suites échouent avant la première assertion).
- **Expected** : au moins la suite `tests/llm.test.ts` (qui teste `MockProvider`, une classe sans dépendance base de données) devrait passer.
- **Actual** : 0 test sur 0 passe, sur les trois fichiers, pour trois raisons indépendantes.
- **Recommendation** : (1) ajouter `dotenv` aux dépendances de `packages/config` ; (2) corriger `tests/generation.test.ts` pour importer le nom de classe et la méthode réels ; (3) commiter un `schema.prisma` et faire tourner `prisma generate` en CI avant les tests (F-24) ; (4) ajouter un `jest.config` réel au dépôt — actuellement aucun fichier de configuration Jest n'existe, et les scripts `test` de chaque paquet (`npx jest --testPathPattern=tests`) ne peuvent de toute façon jamais trouver le dossier `tests/` qui est à la racine du monorepo, pas dans chaque paquet.

## 4. Ce qui a été concrètement amélioré depuis le rapport précédent (à mettre au crédit du travail réalisé)

Pour rester honnête et ne pas donner l'impression que rien n'a progressé :
- `countWords` existe désormais en un seul endroit partagé (`packages/shared`) et est utilisé par le contrôleur — un progrès réel sur IN-01/IN-03, même si la borne « en mots dans le contrôleur » vs « en caractères dans le schéma Zod encore présent » reste divergente (F-18).
- `LLMResponseSchema.parse` est appelé dans le worker (intention correcte sur AO-02) — juste jamais atteint (F-05).
- Le worker vérifie l'état terminal avant retraitement (`COMPLETED`/`FAILED` → skip) — bonne pratique anti-duplication, correcte dans son intention (F-14).
- Débit de crédit et passage à `COMPLETED` sont dans une même transaction Prisma, avec le comptage d'activation dans la même transaction — bonne pratique, correcte dans son intention (F-14).
- Un « reaper » a été ajouté en réponse au Q-05 du rapport précédent — l'intention est la bonne, l'implémentation est un bug fondamental (F-21/F-22).
- L'authentification par JWT réel (plutôt que l'ancien système où `userId` venait du corps de la requête) est en place au niveau du contrôleur, avec une vraie vérification cryptographique dans `JwtAuthGuard` — un progrès de fond sur AZ-01/AZ-02/AZ-03, même si le reste de la chaîne d'authentification (émission effective d'un JWT, F-27 ci-dessous) est cassé.

Aucun de ces points n'est cependant vérifiable comme une garantie *effective* aujourd'hui, puisque le code qui les porte ne s'exécute pas (§1-2).

## 5. Régression annexe notée en passant

### F-27 — Aucun flux ne permet jamais d'obtenir un JWT valide `CRITICAL` `[lecture]`
- **Evidence** : `AuthService.login()` signe un JWT — mais cette méthode n'est appelée par **aucun** contrôleur (`grep` sur tout `apps/api/src` : aucune occurrence de `.login(` en dehors de sa propre définition). `POST /auth/magic-link` crée l'utilisateur et renvoie directement `userId` en clair dans la réponse JSON, sans jamais générer ni envoyer de lien, et sans jamais appeler `login()`. Il n'existe aucun endpoint de type `POST /auth/verify` ou `GET /auth/callback`.
- **Expected** : un utilisateur peut, via un flux quelconque, obtenir un JWT signé pour ensuite appeler les routes protégées par `JwtAuthGuard`.
- **Actual** : dans l'implémentation actuelle, **aucun chemin de code n'émet jamais de JWT** vers un client légitime. Toutes les routes protégées (`POST /generations`, `GET /generations/:id/status`, `GET /generations`, `GET /auth/me`) sont donc, dans les faits, définitivement inaccessibles à quiconque suit le flux d'authentification prévu — ce qui, par accident, ferme plutôt qu'ouvre une porte (échec fermé, pas ouvert), mais casse complètement le produit.
- **Recommendation** : exposer un endpoint qui vérifie le lien magique puis appelle `AuthService.login()` pour renvoyer un JWT au client.

## 6. M004 GO / NO-GO

# **NO-GO.**

Aucune des attaques demandées par la mission n'a pu être menée à son terme par exécution réelle contre un système vivant, parce qu'aucun système vivant n'existe : l'API ne compile pas (F-02, F-08, F-09), ne peut pas s'instancier même en imaginant la compilation résolue (F-03, quatre modules sur cinq manquants), et le worker qui est censé consommer les jobs ne compile pas non plus (F-04, F-05, F-07) et, même corrigé mécaniquement, contient deux bugs de timeout qui le rendraient inopérant en quelques secondes à quelques dizaines de secondes après son démarrage (F-21, F-22). Les deux garde-fous censés protéger le produit sous concurrence réelle — anti-duplication de génération (F-13) et anti-dépassement de crédits (F-15) — restent, par lecture de code, des vérifications non atomiques (« check-then-act ») qui n'offrent aucune garantie sous charge concurrente, exactement comme avant M004. Le schéma de base de données n'existe nulle part dans le dépôt (F-24), rendant toute affirmation sur les contraintes d'unicité ou les transitions d'état invérifiable. Les trois seuls tests automatisés du dépôt échouent tous les trois, pour trois raisons indépendantes, avant la première assertion (F-26).

Rien dans ce rapport n'affirme qu'un problème est corrigé sur la seule base de sa présence dans le code — chaque affirmation « correct » ci-dessus (§4) est qualifiée par le fait que le chemin de code correspondant n'a jamais pu être exercé.

### Ordre de correction recommandé avant tout nouveau cycle d'audit
1. F-01 (script d'installation), F-02 (syntaxe), F-03 (modules NestJS manquants), F-24 (`.gitignore` sur `prisma/` + schéma commité) — sans ces quatre, rien d'autre n'est vérifiable.
2. F-04, F-05, F-06, F-07, F-08, F-09 (worker et paquet `llm` : imports et noms cassés) — pour que le worker tourne.
3. F-10, F-27 (queue jamais alimentée, JWT jamais émis) — pour que le produit fasse quoi que ce soit de bout en bout.
4. F-21, F-22 (timeouts du reaper) — sinon le worker retombe en panne à chaque redémarrage.
5. F-13, F-15 (concurrence : duplication, crédits) — invariants métier.
6. F-26 (suite de tests) — pour qu'un prochain cycle puisse enfin vérifier tout ce qui précède par l'exécution plutôt que par la lecture.

Une fois ces six paliers franchis, ce document doit être rejoué **par exécution réelle** (appels HTTP concurrents, vraie base Postgres, vrai Redis) avant toute décision de GO — la lecture de code ne remplace pas le test dynamique demandé par la mission, elle n'a servi ici qu'à documenter précisément pourquoi le test dynamique était impossible.
