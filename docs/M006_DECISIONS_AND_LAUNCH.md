# M006_DECISIONS_AND_LAUNCH.md

**Mission** : M006.1 — Specification Reconciliation
**Auteur** : Claude1 (Product Lead) — **Date** : 2026-11-11
**Destinataires** : OpenCode (implémentation), Claude2 (QA/sécurité), ClaudeCode (release), owner
**Nature** : gouvernance produit. Aucun code, aucun merge.

# Statut final : **READY FOR IMPLEMENTATION SPEC**

Périmètre couvert : **M007** (intégrité du pipeline) et **M008** (rendu et fichiers) sont spécifiés sans ambiguïté bloquante.
Réserves, qui ne bloquent pas M007 :
- **M010 (paiement)** reste conditionnel aux décisions O-1 et O-2 de l'owner (§12). Il peut démarrer avec le mock de paiement.
- **L'ouverture publique** reste conditionnelle à O-6 (vérification d'email, récupération de mot de passe).
- **L'intégration de M004 dans `develop` n'a pas eu lieu** et ne peut pas avoir lieu avant la sortie de M007 (§2).

---

## 0. Ce qui change dans cette révision

La première version de M006 (PR #14) contenait plusieurs affirmations fausses ou contredites par le code réel. Corrections :

| Sujet | Version initiale | Réalité vérifiée | Traitement |
|---|---|---|---|
| D-13 | « Le code M003/M004 est maintenant sur `develop` » | `develop` contient l'ancien code cassé. Le correctif vit sur `fix/m004-recovery`, 10 commits devant, **jamais intégré**. | §2 corrigé, séquence d'intégration réelle |
| D-02 | « Pas de table `Slide` » | La table `Slide` **existe** (contrainte `(generationId, order)` unique) et c'est l'interface M004 → rendu. | **Décision retirée** : `Slide` est conservée (§4.1) |
| D-11 | « Crédits à la première vérification du lien magique » | Les magic links ont été supprimés (M004.3). Email + mot de passe ; 3 crédits attribués **atomiquement à l'inscription**. | Aligné (§4.4). Vraie vérification d'email chiffrée, non exigée |
| D-14 | « Un seul retry, sur JSON inparsable » | Deux mécanismes distincts : retries BullMQ (erreurs techniques) et un retry de génération (JSON invalide). Le premier est corrigé et prouvé en M004.2. | Distingués (§4.3) |
| D-04 | « Tronquer titre et corps » | Dit trop peu : les échecs de structure doivent rester terminaux. Et **le code ne tronque jamais** (§4.2). | Deux couches (§4.2) |
| Invariants | Listés | Sans mécanisme ni test | Mécanisme, contrainte et test de concurrence pour chacun (§6) |
| M007 | « Réparer le build » | Une grande partie existe déjà | Réécrit depuis l'état réel (§8) |
| ADR | Aucun | Codex a signalé l'absence | ADR-010 (paiement) et ADR-011 (authentification) dans `docs/DECISIONS.md` |

---

## 1. Sources lues et méthode

**Rapports lus intégralement** (y compris verdicts et ordres de correction) :
`M004_REDTEAM_REPORT.md` (develop, NO-GO) · `M004_1_REDTEAM_AUDIT.md` (CONDITIONAL GO) · `M004_2_REDTEAM_AUDIT.md` (CONDITIONAL GO, nouveau P0 : connexion par email seul) · `M004_3_REDTEAM_AUDIT.md` (PR #15, **NO-GO : l'API ne démarre pas**) · `M004_1_FINAL_SENIOR_REVIEW.md` (NO-GO) · rapports d'OpenCode `M004_RECOVERY_REPORT`, `M004_2_P0_FIX_REPORT`, `M004_3_AUTH_SECURITY_FIX_REPORT`.

**Code lu** sur `origin/fix/m004-recovery` @ `c3d87b7` : schéma Prisma et migrations, `processor.ts`, `claim.ts`, worker, `shared/types.ts`, contrôleur et service de génération.

**Non revérifié dans le code** : l'état du frontend. Je m'appuie sur `M004_RECOVERY_REPORT §6` (correctifs web « sans changement fonctionnel ») et sur F-29 du red team.

**Règle de précédence** : si un rapport d'OpenCode se déclare « READY » et qu'un audit indépendant exécuté dit le contraire, l'audit exécuté prévaut. Ici, `M004_RECOVERY_REPORT` et `M004_3_AUTH_SECURITY_FIX_REPORT` annoncent « READY », alors que l'audit M004.3 a démarré l'API pour de vrai et constaté qu'elle ne démarre pas.

**Niveau de preuve des audits** : exécution réelle HTTP + Redis + BullMQ + worker, avec une **base de données substituée** (faux `PrismaService` en mémoire). Le client Prisma réel, `migrate deploy` et PostgreSQL sous charge n'ont jamais été exécutés. La CI n'a jamais tourné sur la branche (0 run).

**Ordre de priorité des documents** (du plus fort au plus faible) : M006 → M005 → M004_PRODUCT_REVIEW → V2 (`PRODUCT_SPEC_V2`, `GENERATION_SPEC`, `AI_PROMPT_SPEC`, `UX_FLOW`) → V1. Un bandeau de renvoi est placé en tête des documents concernés.

---

## 2. D-13 — État réel des branches et séquence d'intégration

### 2.1 État constaté

| Élément | État |
|---|---|
| `develop` (`3748f2a`) | Docs M004/M005 mergés. **Contient encore le code M004 cassé** (NO-GO red team). |
| `fix/m004-recovery` (`c3d87b7`) | `develop` + **10 commits** (récupération, correctifs M004.1 à M004.3, deux audits mergés). Contient le code corrigé. **Non intégrée à `develop`.** |
| PR #14 (`docs/m006-decisions-and-launch` → `develop`) | **Documentaire uniquement.** Ne contient aucun correctif applicatif. |
| PR #15 (`docs/m004-3-redteam-audit` → `fix/m004-recovery`) | Audit M004.3 (NO-GO), docs uniquement, ouverte. |
| CI | **0 exécution** sur `fix/m004-recovery` : le workflow ne se déclenche que sur push ou PR vers `main`/`develop`, et aucune PR n'existe depuis cette branche vers `develop`. |
| Verdict indépendant | **NO-GO** (M004.3) : `JwtAuthGuard` ne peut pas résoudre `JwtService` dans `GenerationModule`, donc `AppModule` ne démarre pas. L'application n'a jamais démarré sur aucun commit de la branche. |

**M004 n'est donc ni intégré à `develop`, ni validé.** M005 (rendu) reste interdit tant que la porte A (§9) n'est pas franchie.

### 2.2 Séquence d'intégration

1. **PR #15** : l'audit M004.3 est mergé dans `fix/m004-recovery`, pour que la preuve voyage avec le code. Décision de Claude2 / de l'owner, sans effet sur le code.
2. **M007 est réalisé sur `fix/m004-recovery`** : pas de nouvelle branche depuis `develop`, pas de cherry-pick.
3. **Dès le premier commit de M007**, ouvrir une PR **brouillon** `fix/m004-recovery` → `develop`. C'est ce qui déclenche enfin la CI, avec Postgres et Redis réels.
4. **Réaudit par Claude2** avec le vrai PostgreSQL et le vrai client Prisma, sans contournement de harnais.
5. **Merge `fix/m004-recovery` → `develop`** (commit de merge, pas de squash : l'historique d'audit est une preuve). C'est **seulement à cette étape que M004 est intégré**.
6. **PR #14 (docs)** : indépendante du code, aucun conflit textuel (la branche de récupération ne modifie que 6 documents nouveaux, la PR #14 modifie d'autres fichiers). Ordre indifférent techniquement ; recommandé en premier, car M007 s'appuie sur ce document.

Rien n'est mergé dans le cadre de M006.1.

---

## 3. Registre des décisions

Légende : **R** = ratifiée (défaut applicable, révocable par l'owner) · **Modifiée** · **Nouvelle**.

| ID | Décision | Statut |
|---|---|---|
| D-01 | Entrée de **80 à 3000 mots**, comptés en mots (`countWords`, fonction partagée client/serveur). Déjà conforme dans le code. | R |
| D-02 | **La table `Slide` est conservée.** `Output` est étendue en M008 (§4.1). | **Modifiée** |
| D-03 | **Une seule génération non terminale par utilisateur**, garantie **en base** (§6, invariant 1). | R |
| D-04 | Validation de la réponse IA en **deux couches** : structure (échecs terminaux) puis longueurs (troncature) (§4.2). | **Modifiée** |
| D-05 | La **valeur** de `source_language` ne bloque jamais une génération (§4.2). | R |
| D-06 | Nouveau type de ledger `PURCHASE` (référence = identifiant de transaction du fournisseur). Migration additive en M010. | R |
| D-07 | Un seul événement d'activation : `user_activated`, id de génération en métadonnée. | R |
| D-08 | Slides rédigées dans la langue du texte source (consigne ajoutée au prompt système, M008-IA). | R |
| D-09 | En production : démarrage refusé sans clé du provider IA, aucun repli vers le mock. Sans objet tant que `OpenRouterProvider` n'existe pas (supprimé en M004). | R |
| D-10 | Achat de crédits autorisé à tout solde. | R |
| D-11 | **Alignée sur l'authentification actuelle** : email + mot de passe, 3 crédits **attribués atomiquement à l'inscription**. Aucune connexion par email seul, jamais (§4.4). | **Modifiée** |
| D-12 | Remplacée par D-15 et O-2. | R |
| D-13 | **Corrigée** : voir §2. | **Modifiée** |
| D-14 | Retries **distingués** : BullMQ (erreurs techniques) / un retry de génération (JSON invalide). Correctif M004.2 préservé (§4.3). | **Modifiée** |
| D-15 | Paiement derrière une interface `PaymentProvider` (§5, ADR-010). | R |
| D-16 | `PAYMENT_PROVIDER=mock` en développement. | R |
| D-17 | **`order` : la position dans le tableau fait foi.** La valeur doit être un entier ; les valeurs ne sont pas exigées contiguës car le serveur renumérote 1..N. Ratifie le comportement actuel. | **Nouvelle** |
| D-18 | **Plafonds de temps** : 90 s par tentative, 3 tentatives maximum, **plafond absolu de 5 minutes** par génération, imposé par un réconciliateur. Remplace « 90 s global » de M004 (§4.3). | **Nouvelle** |
| D-19 | **Contrat HTTP des erreurs** : statut réel + `code` stable (§4.5). | **Nouvelle** |
| D-20 | **Rétention des fichiers** exportés : 90 jours par défaut, configurable ; les `Slide` restent. À confirmer par l'owner (O-7). | **Nouvelle** |
| D-21 | **Email normalisé** (espaces retirés, minuscules) avant unicité et stockage. | **Nouvelle** |

---

## 4. Décisions détaillées

### 4.1 D-02 — Modèle de slides (réponses aux cinq questions)

**Pourquoi la suppression de `Slide` n'est pas nécessaire.** Elle ne l'est pas : j'ai écrit D-02 contre `develop`, qui n'avait pas de modèle `Slide`, sans voir que la branche de récupération en introduit un. `Slide` est précisément « l'interface M004 → M005 » (`M004_RECOVERY_REPORT §15`). La supprimer forcerait à stocker le contenu dans `Output` (qui décrit des fichiers, pas du contenu) ou à relire la réponse brute de l'IA (non persistée). **D-02 est donc inversée.**

**Où les données structurées sont conservées.**

| Table | Contenu | Source de vérité pour |
|---|---|---|
| `Slide` | `order`, `title` (≤ 60), `body` (≤ 220) par génération, unique `(generationId, order)` | Le **contenu** du carrousel |
| `Output` | Fichiers rendus : PNG, ZIP, PDF | Les **livrables** |

**Comment M008 récupère les données.**
- Le rendu lit `Slide WHERE generationId = ? ORDER BY order ASC`, jamais une réponse IA en mémoire.
- **Conséquence produit** : un échec transitoire du rendu ne doit **jamais** provoquer un second appel IA (coût et délai). Si des `Slide` existent déjà pour la génération, la reprise passe directement au rendu.
- **Séquence de persistance M008** (change celle de M004, qui écrit `Slide` + `COMPLETED` + débit en une transaction) :
  1. Transaction A, en fin d'étape IA : écrire les `Slide`, passer à `PROCESSING_RENDER`. **Aucun débit.**
  2. Rendu, upload des fichiers sous des clés déterministes.
  3. Transaction B : écrire les `Output`, passer à `COMPLETED`, débit −1, événement d'activation.
- Le débit reste donc atomique avec `COMPLETED`, exactement comme en M004 (invariant 2).

**Migration de schéma nécessaire (M008).** Additive : `Output` n'a aucun producteur aujourd'hui, donc aucune donnée à migrer.
- Ajouter à `Output` : `slideOrder` (entier, renseigné pour les PNG seulement), `storageKey` (clé stable ; l'URL signée est produite à la demande), date de rétention (D-20).
- `url` et `expiresAt` deviennent facultatifs ou disparaissent : une URL signée expire, la clé de stockage non.
- Unicité imposée en base : un PNG par `(generationId, slideOrder)`, un ZIP et un PDF par génération (index uniques partiels, SQL brut).
- `Slide` : aucune modification.
- Les noms et types exacts relèvent d'OpenCode, **dans ces propriétés**.

**Données qui restent accessibles dans l'historique.**
- Par génération, via la liste : `id`, date, statut, nombre de slides, libellé (titre de la 1re slide, en attendant les vignettes), indicateur « fichiers disponibles / expirés », message d'erreur traduit si `FAILED`.
- Les `Slide` (titre et corps) restent en base indéfiniment pour toute génération `COMPLETED`.
- `sourceText` reste en base mais n'est **jamais** renvoyé par la liste (aujourd'hui `history` renvoie les lignes complètes, `sourceText` inclus : à corriger). Il n'est renvoyé, au propriétaire seulement, que pour une génération `FAILED`, afin de préremplir « Réessayer » après un rechargement de page.
- Après la rétention (D-20) : l'historique indique « fichiers expirés ». Le re-rendu à partir des `Slide` est **hors MVP** (§14).

### 4.2 D-04 / D-05 / D-17 — Validation de la réponse IA

**Constat.** `SlideSchema` impose `.max(60)` et `.max(220)`. La validation Zod échoue donc **avant** la troncature : un titre de 61 caractères produit `FAILED/INVALID_RESPONSE`, et `truncateAtWord` ne reçoit jamais de texte trop long. La troncature décrite par M004 n'existe pas dans les faits (écart E-02).

**Contrat, en deux couches successives.**

*Couche 1 — Structure : tout échec est terminal (`FAILED`, aucun retry, aucun débit).*

| Cas | Résultat |
|---|---|
| Réponse non objet ; `slides` absent, non tableau ou vide | `FAILED` |
| Nombre de slides < 5 ou > 10 | `FAILED` |
| Une slide qui n'est pas un objet | `FAILED` |
| `title` ou `body` absent, `null`, non-chaîne, vide ou composé d'espaces | `FAILED` |
| `order` absent ou non entier (ex. `"1"`) | `FAILED` |
| `meta` absent, ou `meta.slide_count` / `meta.source_language` mal typés | `FAILED` |
| Champs inconnus | Retirés, jamais persistés |

*Couche 2 — Longueurs : uniquement les longueurs excessives, jamais d'échec pour un dépassement modéré.*

| Cas | Résultat |
|---|---|
| `title` > 60 ou `body` > 220, **jusqu'au plafond de sécurité** | Troncature au dernier mot entier + « … » (longueur finale ≤ limite, ellipse comprise). Un mot unique plus long que la limite est coupé à la limite − 1 puis « … » (comportement actuel). |
| `title` > 300 ou `body` > 1100 (plafond de sécurité, soit 5× la limite) | `FAILED / INVALID_RESPONSE` : le modèle ignore le contrat. Valeurs proposées, ajustables par l'owner. |

*Règles complémentaires.*
- **D-05** : la **valeur** de `source_language` ne fait jamais échouer (ni longueur, ni format). Normalisée sur 2 lettres minuscules si possible, sinon ignorée. Seule une valeur qui n'est pas une chaîne est un échec de structure. Le code actuel (`min(2).max(2)`) fait échouer `"fr-FR"` (E-03).
- **D-17** : le serveur renumérote les slides 1..N selon la position. Des `order` dupliqués ou non contigus ne font pas échouer. Le code ne vérifie pas non plus `slide_count = slides.length` : `slides.length` fait foi, statu quo conservé.
- **Propriété à tester** : un titre de 70 caractères valide donne `COMPLETED` avec un titre tronqué ; un titre absent, vide ou numérique donne `FAILED`. Implémentation au choix d'OpenCode (par exemple deux schémas : un sans `max` pour la sortie IA, un avec `max` pour la persistance).

**Matrice d'acceptation (à automatiser, provider stub).**

| Entrée du provider | Résultat attendu |
|---|---|
| Titre de 61 / corps de 235 caractères | `COMPLETED`, texte tronqué, ≤ limite |
| Titre de 400 / corps de 1500 caractères | `FAILED / INVALID_RESPONSE` |
| `title` ou `body` absent / `null` / `123` / `""` / `"   "` | `FAILED / INVALID_RESPONSE` |
| 4 slides, 11 slides, `slides` absent ou vide | `FAILED / INVALID_RESPONSE` |
| `order: "1"` | `FAILED / INVALID_RESPONSE` |
| `order` dupliqués ou en 3,1,2,7,5 | `COMPLETED`, renumérotés 1..N |
| `source_language`: `"fr-FR"`, `"French"`, `""` | `COMPLETED` |
| Champ inconnu `html` sur une slide | `COMPLETED`, champ absent en base |

*Codes.* Catalogue canonique : `INVALID_RESPONSE` = JSON non parsable après le retry ; `MALFORMED_OUTPUT` = JSON valide mais structure ou bornes invalides. Le code actuel les a **inversés** (E-10). Le message utilisateur est identique : écart interne, à corriger sans urgence.

### 4.3 D-14 / D-18 — Retries et plafonds de temps

**Deux mécanismes distincts, à ne jamais confondre.**

| | Retry BullMQ | Retry de génération (JSON invalide) |
|---|---|---|
| **Déclencheur** | Erreur **technique transitoire** : réseau, 429/5xx, timeout du provider, lecture ou transaction DB transitoire | Le provider a répondu mais la réponse **n'est pas du JSON parsable** |
| **Où** | **Entre** deux exécutions du job : la génération est remise à `QUEUED`, l'erreur est relancée, BullMQ redélivre, le worker reprend par un claim atomique | **À l'intérieur** d'une exécution, jamais via BullMQ |
| **Combien** | `attempts: 3`, backoff exponentiel (2 s de base) | **Exactement 1**, avec le prompt de correction |
| **Statut visible** | Inchangé pour l'utilisateur (« Préparation… » / « Analyse… ») | Invisible |
| **Après épuisement** | `FAILED` (`TIMEOUT` ou `LLM_ERROR`, `TRANSACTION_ERROR` pour une transaction), aucun débit | `FAILED / INVALID_RESPONSE` |
| **État du correctif** | **Corrigé et prouvé en M004.2** (preuve exécutée en réel au M004.3 : 2 appels IA, 1 débit). **Ne pas le toucher.** | **N'existe que comme simulation** : le marqueur `__MOCK_INVALID_JSON__`. Aucun vrai chemin de retry JSON n'existe, car `OpenRouterProvider` a été supprimé (E-09). À construire en **M008-IA**. |

**Aucun retry** pour une réponse JSON parsable mais invalide (couche 1 de §4.2) : `FAILED` immédiat, 1 seul appel provider.

**Coût maximal** : 3 tentatives × 2 appels = **6 appels provider** par génération, pour une seule génération débitée. À surveiller à l'activation du provider réel.

**D-18 — Plafonds de temps.**
- **90 s par tentative** (budget mesuré depuis le début de chaque tentative, jamais depuis le démarrage du processus : leçon de F-21/F-22).
- **3 tentatives maximum**.
- **Plafond absolu de 5 minutes** entre la création et un état terminal : le pire cas théorique (3 × 90 s + backoff) est ≈ 4,6 min.
- Un **réconciliateur périodique** (toutes les minutes environ) passe en `FAILED / TIMEOUT` toute génération non terminale créée depuis plus de 5 minutes, en comparant l'âge **de chaque ligne** à l'heure courante. Il couvre les cas qu'aucun redélivrement ne résout : ligne `QUEUED` sans job, job perdu après un vidage de Redis, worker mort.
- Un job tardif qui arrive ensuite sur une génération terminale est ignoré (déjà le cas : `skipped`).
- Côté interface : après 120 s, « La génération continue en arrière-plan » (M004 §4.3, inchangé).

### 4.4 D-11 / D-21 — Authentification

**Alignement.** L'authentification est **email + mot de passe** (M004.3) : `POST /auth/register` (201, sans jeton), `POST /auth/login` (200, JWT après `bcrypt.compare`). Les 3 crédits gratuits sont écrits **dans la même transaction que la création du compte** (`MANUAL_GRANT`, référence `signup_bonus`) ; un second enregistrement échoue sur l'unicité de l'email avant toute écriture.

**Règle ferme** : aucune route ne délivre de JWT sur la seule base d'un email, ni comme `login`, ni comme `magic-link`, ni autrement. Cette règle est ajoutée aux critères d'acceptation.

**Exigences complémentaires (D-21).**
- Email : espaces retirés, minuscules, **avant** l'unicité. Aujourd'hui `Victim@Example.com` et ` victim@example.com` sont des comptes distincts, chacun avec 3 crédits (P1-4). Les alias `+` sont conservés (légitimes).
- `AUTH_SECRET` : 32 caractères minimum, refus du démarrage sinon.
- Le « dummy-hash » (hash factice pour le temps constant) fait 67 caractères alors qu'un hash bcrypt valide en fait 60 : `bcrypt.compare` le rejette immédiatement, d'où 82,9 ms contre 1,6 ms. Le login ne masque donc pas l'existence d'un compte. À corriger avec un test **de temps**.
- Un enregistrement concurrent du même email doit répondre `409 EMAIL_TAKEN`, pas `500` (prouvé : 2 réponses 500 sur 6).
- `/auth/me` renvoie les crédits figés dans le JWT : le solde affiché doit venir du ledger.
- Le JWT expiré ou absent répond **401**, pas 403.

**Vérification d'email : coût et architecture, non exigée à ce stade.**

| Élément | Contenu |
|---|---|
| Ce qu'elle résout | Le farming de crédits gratuits par comptes multiples (chaque crédit = un appel IA payant) et l'usurpation par email erroné |
| Composants | Fournisseur d'envoi transactionnel + domaine d'envoi configuré (SPF/DKIM) ; table de jetons (hash du jeton, expiration, usage unique) ; colonne `emailVerifiedAt` ; routes de vérification et de renvoi (avec limitation de débit) ; un `MailerProvider` en mode mock qui journalise le lien en développement (même logique que `LLMProvider`, budget 0 €) |
| Changement de flux | L'inscription crée un compte **non vérifié** ; les 3 crédits sont attribués **à la vérification** (l'unicité `signup_bonus` du ledger les rend déjà idempotents) ; la génération exige un compte vérifié. **Cela contredit « crédits atomiques à l'inscription » et ne se fait donc qu'avec accord de l'owner.** |
| UX | Un écran « Vérifiez votre email » avec renvoi ; un point de friction de plus dans l'entonnoir d'activation |
| Effort estimé | Environ un jalon de la taille de M010 (backend, deux écrans, mock, tests) |
| Bénéfice annexe | La **récupération de mot de passe** réutilise la même infrastructure |

**Lacune connue, à assumer** : sans envoi d'email, il n'existe **aucune récupération de mot de passe**. Pour le lancement doux (10 à 20 invités), l'owner réinitialise manuellement. Pour l'ouverture publique, voir O-6.

**Protection minimale avant ouverture publique, sans email** (portes E) : limitation de débit sur `/auth/*`, coût bcrypt relevé à 12, JWT de 24 h avec refresh au lieu de 7 jours.

### 4.5 D-19 — Contrat HTTP des erreurs

Corps d'erreur uniforme : `{ statusCode, code, message }`. Le front s'appuie sur `code`, jamais sur le texte. Les statuts sont **réels** : aujourd'hui `POST /generations` renvoie **HTTP 201** pour des erreurs de validation, avec `statusCode` dans le corps (P1-3).

| Route | Cas | HTTP | `code` |
|---|---|---|---|
| `POST /generations` | Créée | 201 | — (`generationId`, `status: QUEUED`) |
| | < 80 mots / > 3000 mots | 400 | `INPUT_TOO_SHORT` / `INPUT_TOO_LONG` (+ nombre de mots manquants / en trop) |
| | Corps sans `sourceText` | 400 | `INPUT_TOO_SHORT` |
| | Jeton absent, invalide ou expiré | 401 | `UNAUTHENTICATED` |
| | Solde insuffisant | 402 | `NO_CREDITS` |
| | Génération déjà en cours | 409 | `GENERATION_IN_PROGRESS` (+ id de la génération active) |
| | File indisponible | 503 | `QUEUE_UNAVAILABLE` (la ligne est passée en `FAILED`, l'utilisateur n'est pas bloqué) |
| `GET /generations/:id/status` | Introuvable **ou** appartient à un autre | 404 | `NOT_FOUND` (même réponse dans les deux cas) |
| `POST /auth/register` | Succès / invalide / email pris | 201 / 400 / 409 | — / `INVALID_INPUT` / `EMAIL_TAKEN` |
| `POST /auth/login` | Succès / invalide / identifiants faux | 200 / 400 / 401 | — / `INVALID_INPUT` / `INVALID_CREDENTIALS` |

Le chemin de suivi reste `GET /generations/:id/status` (existe et est testé ; M008 y ajoute la liste des fichiers). Le préfixe d'API est `/api`.

`QUEUE_UNAVAILABLE` et `TRANSACTION_ERROR` sont ajoutés au catalogue d'erreurs : ils tombent sur le message générique « Une erreur est survenue. Réessayez. ». Les autres messages de M004 §6.2 sont inchangés.

---

## 5. Paiement — D-15, D-16 (voir ADR-010)

Stripe n'ouvre des comptes marchands que dans une liste limitée de pays. Le Cameroun n'apparaît pas dans les sources que j'ai consultées (il n'y figure que pour *Stripe Tax*, qui calcule des taxes). **À confirmer par l'owner sur la page officielle « Stripe Global Availability »** avant d'écarter Stripe définitivement.

| Option | Apport | Réserves |
|---|---|---|
| **Flutterwave** | Licence de paiement au Cameroun (annoncée en 2025), mobile money, cartes, virements, liens de paiement | Frais et règlement plus lents que les agrégateurs locaux d'après un comparatif d'intégrateur |
| **Agrégateurs locaux** (Notch Pay, MeSomb, CinetPay, Fapshi) | MTN MoMo et Orange Money, frais indicatifs 1,5–3,5 %, règlement T+1 à T+3 | Chiffres issus de blogs d'intégrateurs : ordres de grandeur, à vérifier auprès de chaque fournisseur |
| Stripe via entité étrangère | Checkout de référence | Entité et compte bancaire à l'étranger : hors délai et hors budget |

**Contrat produit du paiement** (valable quel que soit le fournisseur) :
- Interface `PaymentProvider`, sur le modèle de `LLMProvider`, sélectionnée par `PAYMENT_PROVIDER` (`mock` par défaut hors production). **Un seul fournisseur actif** au lancement.
- Checkout **hébergé** par le fournisseur ; aucun numéro de carte ni de mobile money dans Slideify.
- **Une commande est enregistrée avant la redirection** (utilisateur, fournisseur, référence, montant, devise, crédits du pack), pour que le retour puisse être rattaché à l'utilisateur et vérifié.
- **Crédit uniquement après vérification côté serveur** de la transaction auprès du fournisseur. Le montant crédité vient de la configuration du pack, jamais du paramètre de retour ni du corps du webhook.
- Mobile money : la confirmation peut prendre de quelques secondes à quelques minutes. L'état « Confirmation du paiement en cours… » tolère plusieurs minutes et propose un retour au Dashboard.
- Remboursement : manuel, par l'owner (`REFUND` dans le ledger). Aucun écran.
- Le mock simule **succès, annulation, échec et confirmation retardée**.
- Invariant 3 de §6 s'applique.

Ouverture du compte marchand à lancer **maintenant** : la vérification peut prendre plusieurs jours.

---

## 6. Invariants produit : mécanisme, contrainte et test

Chaque invariant doit tenir **sous concurrence réelle, sur PostgreSQL réel** (service de la CI), avec le serveur HTTP réel. Un faux en mémoire sans point d'attente interne ne prouve pas l'atomicité (réserve de l'audit M004.2).

### Invariant 1 — Au plus une génération non terminale par utilisateur
- **Mécanisme** : index unique partiel sur `Generation(userId)` pour les statuts `QUEUED`, `PROCESSING_LLM`, `PROCESSING_RENDER` (SQL brut dans la migration). La création est un `INSERT` ; une violation d'unicité (code Prisma `P2002`) est traduite en `409 GENERATION_IN_PROGRESS`. La pré-vérification `hasInProgress` n'est qu'un raccourci de lecture.
- **Dépendance** : sans le réconciliateur de D-18, une ligne bloquée verrouillerait l'utilisateur à vie (P1-2). L'invariant et le réconciliateur se livrent ensemble.
- **Test de concurrence** : 10 `POST /generations` simultanés du même utilisateur (solde suffisant) → **exactement 1 réponse 201** et 9 réponses 409 ; exactement 1 ligne non terminale en base. Puis : après passage en `FAILED`, un nouveau `POST` est accepté. Puis : une ligne `QUEUED` sans job, plus ancienne que 5 minutes, est passée en `FAILED / TIMEOUT` par le réconciliateur (horloge simulée) et l'utilisateur peut relancer.

### Invariant 2 — Un seul débit par génération `COMPLETED`
- **Mécanisme** : (a) transaction de complétion unique (écriture de `COMPLETED` + `Output`/`Slide` selon la séquence de §4.1 + débit + événement) ; (b) passage à `COMPLETED` conditionnel (`UPDATE … WHERE status IN (PROCESSING_*)` avec contrôle du nombre de lignes) pour qu'une seconde complétion échoue et soit annulée ; (c) unicité existante `(userId, type, reference)` avec `reference = generation:<id>` **non nulle**.
- **Contraintes à ajouter** : `CHECK` « un `GENERATION_DEBIT` a un `amount` de −1 et une `reference` non nulle » (une référence `NULL` contourne l'unicité en PostgreSQL).
- **Correction requise** : la détection de doublon se fait aujourd'hui en cherchant le texte `'Unique constraint'` dans le message d'erreur. Elle doit se faire par le **code d'erreur Prisma `P2002` sur la contrainte concernée** (écart E-08, point de catégorie C de l'audit).
- **Test** : deux `processGeneration` simultanés sur la même génération, vrai PostgreSQL → 1 débit, 1 jeu de slides, 1 événement. Rejeu après `COMPLETED` (accusé de réception perdu) → `skipped`, toujours 1 débit. Complétion forcée en double → succès idempotent, 1 débit.

### Invariant 3 — Un seul crédit par transaction de paiement
- **Mécanisme** : ligne de ledger `PURCHASE` avec `reference` = identifiant de transaction du fournisseur ; **unicité globale** sur `(type, reference)` pour `PURCHASE` (index partiel, pas seulement par utilisateur) ; table `WebhookEvent` avec unicité `(provider, eventId)` ; vérification serveur de la transaction avant crédit ; montant issu de la configuration du pack ; la commande enregistrée avant la redirection porte l'utilisateur.
- **Test** : le même événement de paiement envoyé 2 fois **en parallèle** → 1 seul crédit ; montant ne correspondant pas au pack → aucun crédit ; transaction non vérifiable chez le fournisseur → aucun crédit ; rejeu après succès → toujours 1 crédit. (M010, avec le mock.)

### Invariant 4 — Le solde ne devient jamais négatif
- **Constat** : solde = 1, 5 `POST` simultanés → 2 générations acceptées, 2 débits, **solde final −1** (prouvé en réel, P1-1). Le débit ayant lieu à la complétion, la vérification `hasCredits` avant création ne protège rien sous concurrence.
- **Mécanisme** : sérialisation par utilisateur. À la création **et** à la complétion, la transaction verrouille la ligne `User` (`SELECT … FOR UPDATE`) ou prend un verrou consultatif transactionnel sur l'utilisateur, puis calcule le solde dans le verrou. Création : solde ≥ 1 + nombre de générations non terminales de l'utilisateur. Complétion : solde ≥ 1 sinon la génération échoue en `NO_CREDITS` sans débit. Avec l'invariant 1, ce second cas est inatteignable en usage normal et sert de filet de sécurité.
- **Contrainte** : `CHECK` sur le ledger (débit = −1) ; aucune écriture hors `ADJUSTMENT` ne peut rendre le solde négatif.
- **Test** : solde = 1, 10 `POST` simultanés → 1 accepté, solde final 0, jamais −1. Mixte : un achat et une génération en parallèle. **Le scénario qui a produit −1 devient un test de non-régression.**

### Invariant 5 — Aucun fichier orphelin visible ni conservé indéfiniment
Une contrainte SQL ne suffit pas : le stockage d'objets n'est pas dans la transaction PostgreSQL. Il existe deux classes d'orphelins : (a) objet en stockage sans ligne `Output` (upload réussi, transaction annulée ou worker mort avant le commit) ; (b) ligne `Output` pointant vers un objet absent.

- **Mécanisme de prévention** : clés **déterministes** par génération (`generations/<id>/slide-01.png`, `…/carousel.zip`, `…/carousel.pdf`) : un retry **écrase** au lieu de dupliquer, donc l'ensemble d'orphelins possible est borné par génération. Les `Output` sont écrits **après** les uploads, dans la transaction B (§4.1). Au passage en `FAILED`, nettoyage au mieux des objets déjà envoyés.
- **Réconciliateur de stockage** (même processus que le réconciliateur de D-18, exécution horaire) :
  1. Pour chaque préfixe de génération en stockage plus ancien que le délai de grâce (**1 heure**, supérieur au plafond de 5 min) : si la génération est `FAILED`, inexistante, ou n'a aucun `Output` correspondant → **supprimer l'objet**.
  2. Pour chaque `Output` dont l'objet manque (vérifié à l'échantillon et, de toute façon, au moment du téléchargement) → marquer le fichier indisponible ; l'utilisateur voit « fichiers expirés », jamais une erreur 500.
  3. Fichiers au-delà de la rétention (D-20) → supprimer l'objet et marquer l'`Output` expiré.
  4. **Ne jamais toucher** une génération non terminale ni une génération plus récente que le délai de grâce.
- **Tests** :
  - Injection de panne entre l'upload et le commit → après un passage du réconciliateur, **0 objet orphelin** et 0 `Output` inexistant.
  - Arrêt du worker entre l'upload et le commit, puis retry → exactement N PNG + 1 ZIP + 1 PDF, `Output` cohérents.
  - Le réconciliateur est **idempotent** et ne supprime **jamais** les objets d'une génération en cours (test avec une génération non terminale).
  - Un `Output` sans objet → réponse « fichiers expirés », pas d'erreur serveur.
  - Exécution en CI sur le stockage local ; sur le stockage réel en staging.

---

## 7. Écarts constatés entre le code (`fix/m004-recovery`) et les contrats

| # | Écart | Source | Traité en |
|---|---|---|---|
| E-01 | L'API ne démarre pas (injection de `JwtService` dans `GenerationModule`) | Audit M004.3 P0-1 | M007 |
| E-02 | `SlideSchema` impose `max(60)/max(220)` avant la troncature : un titre de 61 caractères échoue | Lecture de `shared/types.ts` + `processor.ts` | M007 |
| E-03 | `source_language` : `min(2).max(2)` bloque `"fr-FR"` | `shared/types.ts` | M007 |
| E-05 | Course `hasInProgress` / `hasCredits` : solde −1 prouvé | Audit P1-1 | M007 |
| E-06 | Redis arrêté au `POST` : requête suspendue, ligne `QUEUED` sans job, utilisateur verrouillé | Audit P1-2 | M007 |
| E-07 | Erreurs renvoyées en HTTP 201 ; 403 au lieu de 401 ; `getStatus` lève une `Error` native (500) | Audit P1-3, P2-2, P2-4 | M007 |
| E-08 | Doublon de débit détecté par le **texte** du message d'erreur | `processor.ts` ; catégorie C de l'audit | M007 |
| E-09 | `OpenRouterProvider` absent ; le retry JSON n'est qu'une simulation | `processor.ts`, recovery §3 | M008-IA |
| E-10 | `INVALID_RESPONSE` et `MALFORMED_OUTPUT` inversés ; le code de production lit des marqueurs de test (hors production) | `processor.ts` | M007 |
| E-11 | L'événement émis est `first_generation_completed`, pas `user_activated` (D-07) | `processor.ts` | M007 |
| E-12 | `TRANSACTION_ERROR` hors catalogue | `processor.ts` | M007 (catalogue) |
| E-13 | `Output` sans ordre ni clé ; `url` et `expiresAt` obligatoires ; pas d'unicité | `schema.prisma` | M008 |
| E-14 | Pas de type `PURCHASE` | `schema.prisma` | M010 |
| E-15 | Aucun `CHECK` sur le ledger | `schema.prisma` | M007 |
| E-16 | Email non normalisé ; `AUTH_SECRET` sans longueur minimale ; dummy-hash invalide ; course au register → 500 ; troncature bcrypt à 72 octets alors que 128 sont autorisés | Audit M004.3 §2 | M007 (sauf débit : M012) |
| E-17 | `/auth/me` renvoie des crédits périmés (valeur du JWT) | Audit P2-5 | M007 |
| E-18 | `history` renvoie `sourceText` | Audit P3 | M007 |
| E-19 | Aucun réconciliateur ni plafond absolu | Audit P1-2 | M007 |
| E-20 | Frontend non relié à l'API (d'après recovery §6 et F-29, **non revérifié**) | Red team F-29 | M009 |
| E-21 | CI jamais exécutée ; `migrate deploy`, client Prisma réel et 2 tests `schema` jamais exécutés | Audit M004.3 §0 | M007 |

---

## 8. M007 réécrit depuis l'état réel de `fix/m004-recovery`

**Base de travail** : `fix/m004-recovery` @ `c3d87b7`. Aucune nouvelle branche depuis `develop`.

### 8.1 Existe déjà : ne pas réimplémenter

| Élément | Preuve disponible |
|---|---|
| File BullMQ réelle injectée, charge utile `{ generationId }` seule | Réel (audit M004.3) |
| Un seul consommateur (`apps/worker`) | Réel |
| Claim atomique `QUEUED → PROCESSING_LLM` (`updateMany`) | Atomicité SQL supposée (catégorie B) |
| **Retry transitoire corrigé** (reset à `QUEUED`, relance, 2ᵉ appel IA, 1 débit) | **Prouvé en réel**, y compris backoff BullMQ |
| Reprise d'une génération `PROCESSING` périmée (> 180 s) | Prouvée en réel |
| Débit idempotent par contrainte, transaction de complétion unique | Contrainte vérifiée en PostgreSQL ; comportement client Prisma : catégorie C |
| Validation en mots (79/80/3000/3001) | Prouvée en réel |
| Table `Slide`, unicité `(generationId, order)`, `VarChar(60/220)` | Vérifiée en PostgreSQL réel |
| Auth email + mot de passe : bcryptjs salé, 401 identiques, JWT HS256, identité tirée du JWT uniquement, aucune route d'émission par email seul | Prouvé en réel |
| Migrations valides sur base vierge | Vérifié par `psql` |
| 50 tests (48 exécutés par l'audit, 2 `schema` bloqués par Prisma) | Confirmé |

### 8.2 À faire en M007, par ordre

1. **[P0] L'API démarre.** Fournir `JwtService` à `GenerationModule` ; **test qui démarre `AppModule` réel** ; test HTTP du `/api/health`. C'est le test dont l'absence a caché E-01 aux 50 tests.
2. **CI réelle** : ouvrir la PR brouillon vers `develop` (§2.2) ; services PostgreSQL et Redis ; `prisma generate`, `migrate deploy`, puis tests unitaires + intégration + **parcours live** (register → login → `POST` → `COMPLETED` → un débit). Première exécution de tout ce qui est en catégorie C.
3. **[P1] Invariants 1 et 4** (index partiel, sérialisation par utilisateur) avec leurs tests de concurrence.
4. **[P1] Panne Redis** (E-06) : délai borné sur l'enfilage ; en cas d'échec, la ligne passe en `FAILED / QUEUE_UNAVAILABLE`, réponse 503, utilisateur non bloqué. **Réconciliateur et plafond de 5 minutes** (D-18), avec l'invariant 1.
5. **[P1] Contrat HTTP** (D-19) : statuts réels, filtre d'exceptions global, `NotFoundException` sur la lecture d'une génération d'autrui, 401 au lieu de 403.
6. **Alignement validation** : deux couches (D-04), `source_language` non bloquant (D-05), renumérotation (D-17), détection d'unicité par code `P2002` (E-08), codes `INVALID_RESPONSE` / `MALFORMED_OUTPUT` corrigés (E-10), `TRANSACTION_ERROR` et `QUEUE_UNAVAILABLE` au catalogue, événement `user_activated` (E-11), `CHECK` du ledger (E-15).
7. **Lot authentification** : email normalisé (D-21), `AUTH_SECRET` ≥ 32, dummy-hash valide avec test de temps, 409 à la place du 500 sur course au register, `/auth/me` lit le ledger, `history` sans `sourceText`.
8. **Tests manquants** listés par l'audit : boot `AppModule`, HTTP réel, temps du dummy-hash, course d'API sur `hasInProgress`/`hasCredits`, propriété d'une génération, indisponibilité Redis.
9. **Réaudit Claude2** avec le vrai PostgreSQL et le vrai client Prisma, sans contournement de harnais.

### 8.3 Hors M007

Rendu, stockage, `Output` (M008) · provider IA réel et retry JSON réel (M008-IA) · front (M009) · `PURCHASE` et paiement (M010) · vérification d'email · limitation de débit et durcissement JWT (porte E, M012).

### 8.4 Critères de sortie de M007 (porte A)

- La CI est **verte** sur la PR.
- Le test de démarrage de `AppModule` passe.
- Le parcours live passe sur PostgreSQL et Redis réels.
- Les tests de concurrence des invariants 1, 2 et 4 passent sur PostgreSQL réel.
- La matrice de §4.2 passe.
- Claude2 : **GO**, sans P0 ni P1 ouvert sur le pipeline.

---

## 9. Portes de mise en production

Dans l'ordre. Toutes sont nécessaires.

| Porte | Contenu | Preuve | Responsable |
|---|---|---|---|
| **A — Build et exécution** | Critères de §8.4. | CI verte + rapport Claude2 | OpenCode, Claude2 |
| **B — Conformité produit** | Tous les critères de `ACCEPTANCE.md` vérifiés en staging, avec les remplacements de M004/M005/M006 (authentification par mot de passe, codes M003, paiement générique). Chemins d'erreur exercés avec les marqueurs du mock. Invariants du §6. Aucun code technique dans l'interface. | Matrice critère × résultat | Claude1, Claude2 |
| **C — Qualité du résultat** | 10 textes de référence (5 FR, 3 EN, 1 de 80 mots, 1 de 3000 mots) avec le **vrai provider IA** : 5 à 10 slides, langue source, aucun texte coupé, lisible sur 390 px, PDF de N pages en 4:5, ZIP de N PNG. **Au moins 8 sur 10 jugés « publiables tels quels »**. | Grille de jugement | Owner (O-3, O-5) |
| **D — Commercial et légal** | Compte de paiement actif ; achat réel de petit montant puis remboursement manuel ; prix défini ; conditions d'utilisation, politique de confidentialité (mentionner l'envoi des textes à un fournisseur d'IA tiers), politique de remboursement, contact support ; obligations locales de facturation et de protection des données vérifiées par un comptable ou un juriste. | Pages publiées + reçu de test | Owner |
| **E — Exploitation** | Production distincte du staging ; `AI_PROVIDER` et `PAYMENT_PROVIDER` en mode réel, démarrage refusé si une clé manque ; **aucun secret dans le dépôt, jetons ayant circulé révoqués et remplacés** ; limitation de débit sur `/auth/*`, bcrypt à 12, JWT 24 h + refresh ; sauvegarde de la base ; journaux sans fuite de contenu ; domaine + HTTPS ; réconciliateurs actifs ; procédure de retour arrière. | Liste de contrôle signée | ClaudeCode |

*Option à décider* : un plafond journalier global de générations (une variable d'environnement) pour borner la dépense IA en cas d'abus. Non retenu par défaut.

---

## 10. Feuille de route

Pas de dates : elle dépend de la vitesse de M007 et du délai d'ouverture du compte de paiement.

| Jalon | Contenu | Responsable | Sortie |
|---|---|---|---|
| **M006.1** | Ce document, ADR-010/011, réponses à Codex | Claude1 | Spécifications cohérentes |
| **M007** | §8 | OpenCode, puis Claude2 | Porte A |
| **M008** | Rendu 1080×1350, PNG, PDF de N pages, ZIP ; séquence de persistance §4.1 ; réconciliateur de fichiers (invariant 5). **Démarre après la porte A** (Claude2 a interdit M005 avant). | OpenCode | Contrat M005 |
| **M008-IA** (parallèle) | `OpenRouterProvider` réel, **vrai retry JSON**, consigne de langue (D-08), refus de démarrage en production (D-09), `AI_PROVIDER` ; tests avec un provider stub non-JSON puis valide | OpenCode | Retry JSON prouvé |
| **M009** | Front : écrans d'inscription et de connexion (email + mot de passe), générateur, suivi, résultat, historique, erreurs traduites, mobile ; liaison à l'API réelle | OpenCode | Parcours complet |
| **M010** | `PaymentProvider`, mock, fournisseur retenu, `PURCHASE`, écran Achat | OpenCode | Invariant 3, critères de §5 |
| **M011** | Régression QA/sécurité ; qualité avec le vrai provider | Claude2, owner | Portes B et C |
| **M012** | Staging, pages légales, exploitation, achat réel de test | ClaudeCode, owner | Portes D et E |
| **Lancement doux** | 10 à 20 invités, deux semaines | Owner | Indicateurs §11 |
| **Ouverture publique** | Après revue des indicateurs et décision O-6 | Owner | — |

M009 et M010 peuvent avancer en parallèle après M007.

---

## 11. Lancement doux : indicateurs

Source : tables `Generation`, `CreditTransaction`, `GenerationEvent`. Aucun outil d'analytics tiers.

| Indicateur | Définition | Seuil proposé |
|---|---|---|
| Taux de réussite | `COMPLETED` / (`COMPLETED` + `FAILED`) | ≥ 90 % |
| Durée | Médiane création → `COMPLETED` | ≤ 45 s |
| Activation | Comptes ayant au moins une génération `COMPLETED` | ≥ 60 % |
| Valeur réalisée | Générations `COMPLETED` suivies d'un téléchargement | ≥ 70 % |
| Conversion | Comptes ayant épuisé 3 crédits et acheté un pack | À observer |

Seuils proposés par moi, ajustables par l'owner. Un taux de réussite sous le seuil bloque l'ouverture même si les autres sont bons.

---

## 12. Décisions réservées à l'owner

| # | Question | Pourquoi je ne peux pas trancher | Bloque |
|---|---|---|---|
| **O-1** | **Fournisseur de paiement** et ouverture du compte marchand ; confirmer sur la page officielle Stripe que le Cameroun n'est pas supporté pour ton entité. | Dépend de l'entité qui encaisse, de l'audience et d'une vérification d'identité personnelle. | M010 (mock possible), porte D |
| **O-2** | **Prix, taille du pack, devise.** Le « 9,90 € barré 19,90 € » du code n'est dans aucune spécification. | Dépend du coût réel d'une génération et du pouvoir d'achat visé. | Porte D |
| **O-3** | **Budget** de validation de la qualité avec le vrai provider IA. | Seule dépense prévue avant le lancement. | Porte C |
| **O-4** | Nom commercial, entité légale, adresse de support. | Informations propres à l'owner. | Porte D |
| **O-5** | **Qui juge** la porte C (« publiable tel quel »). | Doit venir d'un connaisseur du public cible. | Porte C |
| **O-6** | **Vérification d'email et récupération de mot de passe avant l'ouverture publique** : les implémenter (coût de §4.4) ou rester sur le durcissement sans email (limitation de débit, normalisation, bcrypt 12) et la réinitialisation manuelle. | Arbitrage entre friction à l'inscription, coût de développement et risque de farming de crédits. **Ne bloque ni M007 ni le lancement doux.** | Ouverture publique |
| **O-7** | **Rétention** des fichiers (90 jours proposés) et de `sourceText` ; politique de confidentialité correspondante. | Dépend du coût de stockage et d'obligations de protection des données. | Porte D |

---

## 13. Réponses aux remarques Codex (PR #14)

| Remarque | Réponse |
|---|---|
| **P2 — « Preserve schema failures in the new validation rule »** | Fondée. La règle « tronquer titre et corps » ne disait pas que les échecs de **structure** restent terminaux. §4.2 sépare désormais les deux couches : structure manquante, vide, mal typée = `FAILED` ; seules les longueurs excessives sont tronquées, avec un plafond de sécurité. Matrice d'acceptation incluse. |
| **P2 — « Add the payment abstraction to the ADR journal »** | Fondée. **ADR-010 (PaymentProvider)** ajouté à `docs/DECISIONS.md`. **ADR-011 (authentification)** ajouté en parallèle, car D-11 change d'architecture. |

---

## 14. Hors périmètre (rappel)

Ce qui figure déjà dans les listes de M004 et M005, plus : plusieurs fournisseurs de paiement simultanés ; abonnement ; factures PDF automatiques ; parrainage ; tableau de bord d'analytics ; suppression d'historique ; **re-rendu des fichiers expirés à partir des `Slide`** ; vérification d'email et récupération de mot de passe (sous réserve de O-6).
