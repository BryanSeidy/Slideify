# M004_PRODUCT_REVIEW.md

**Mission** : M004-PRODUCT — Generation UX & Product Contract
**Auteur** : Claude1 (Product Lead) — **Date** : 2026-09-28
**Destinataire** : OpenCode (implémentation), owner (arbitrages §11)
**Nature** : revue produit ciblée. Aucun code. Aucune feature ajoutée.

---

## 0. Périmètre, méthode, limites

**Lu** : `PRODUCT.md`, `PRODUCT_SPEC_V2.md`, `GENERATION_SPEC.md`, `AI_PROMPT_SPEC.md`, `UX_FLOW.md`, `DOMAIN_MODEL.md`, `GENERATION_LIFECYCLE.md`, `AI_CONTRACT.md` (obligatoires) + `MILESTONE_003.md`, `DATABASE_DESIGN.md`, `SUMMARY.md`, `AUDIT.md`, et le code de `origin/develop` (`0c6775c`) : API, worker, `packages/{shared,llm,renderer,config}`, pages web.

**Limite majeure — à lire en premier.** Le brief indique que M003 est terminé (JWT, ledger, lifecycle, validation API, MockProvider, BullMQ, Prisma). **Cette implémentation n'est pas visible sur le remote** : aucune branche ni PR M003 (branches : `develop`, `docs/*`, `spec/*`, `chore/*`), pas de `schema.prisma` dans `packages/schema`, pas de guard JWT (`userId` encore lu dans le body), `POST /generations` ne met rien en file (aucun `queue.add`), aucun timeout, `GenerationInputSchema` jamais appliqué. La cohérence ci-dessous est donc vérifiée **doc ↔ doc** et **doc ↔ develop**. Les points qui dépendent du vrai code M003 sont marqués 🔎 (à re-vérifier dès que la branche M003 est poussée — voir D-13).

**Règle d'arbitrage appliquée** (pour ne rien modifier arbitrairement) :
1. Les choix techniques déjà persistés (noms d'états, codes d'erreur, types de ledger) sont **ratifiés tels quels** — on ne renomme pas ce qui est en base.
2. Pour tout ce que l'utilisateur voit (bornes, messages, comportements), le **contrat produit** prévaut.
3. Ce qui ne peut pas être tranché sans le owner est listé au §11 avec un **défaut applicable** : OpenCode n'est jamais bloqué, sauf D-02 et D-13.

**Corrections de ma propre V2** : (a) j'ai omis d'exiger que les slides soient rédigées dans la langue du texte source (D-08) ; (b) ma borne min de 50 mots est révisée à 80 (D-01) ; (c) mes noms d'états/codes/types (V2) sont remplacés par ceux de M003 (§6, §11).

---

## 1. Réponses synthétiques aux 12 questions

| # | Question | Réponse | § |
|---|---|---|---|
| 1 | Contrat de `POST /generations` | Authentifié (JWT). Body : `{ sourceText }` seul. Valide 80–3000 mots, solde ≥ 1, aucune autre génération en cours. Crée `Generation(QUEUED)`, met le job en file, **ne débite rien**, répond immédiatement `{ generationId, status: "QUEUED" }`. | 3 |
| 2 | Champs fournis par l'utilisateur | Un seul : le texte collé. Ni titre, ni ton, ni template, ni nombre de slides, ni langue. | 3.1 |
| 3 | Validations visibles côté UX | Compteur de mots live, message min/max actionnable, bouton désactivé hors bornes, bascule vers « Acheter des crédits » à 0 crédit, message si génération déjà en cours. | 3.2 |
| 4 | États à afficher | `QUEUED`, `PROCESSING_LLM`, `PROCESSING_RENDER`, `COMPLETED`, `FAILED`. **`VALIDATING` n'existe pas** (validation incluse dans `PROCESSING_LLM`). | 4 |
| 5 | Ce que voit l'utilisateur par état | « Préparation… » / « Analyse du contenu… » / « Mise en page du carrousel… » / redirection auto vers Résultat / écran d'erreur avec « Réessayer ». | 4.2 |
| 6 | Résultat attendu | N slides (5–10) rendues en PNG 1080×1350 dans l'ordre, un ZIP de ces PNG, un PDF de N pages, prévisualisables puis téléchargeables. | 5 |
| 7 | Comportement si le provider échoue | Statut `FAILED`, message traduit + « Aucun crédit n'a été débité », bouton « Réessayer » qui ramène au générateur **texte préservé**. Aucune relance auto. | 6.3 |
| 8 | Messages/codes exposés | Codes internes jamais affichés ; table code → message FR unique. | 6.2 |
| 9 | Consommation des crédits | Un seul débit de −1, atomique avec le passage à `COMPLETED`, après stockage des fichiers. Jamais avant, jamais sur `FAILED`. | 7 |
| 10 | Activation | Première génération `COMPLETED` du compte. Événement `user_activated`, émis une seule fois par utilisateur. | 8 |
| 11 | Info affichée sur le résultat | Slides prévisualisées (image réellement téléchargée), position « n / N », navigation, 2 boutons de téléchargement, solde de crédits, retour dashboard. | 5.2 |
| 12 | Nécessaire vs hors scope | Voir §9 et §10. | 9–10 |

---

## 2. Product flow

```
Auth (magic link) ──► Dashboard ──► Générateur ──► En cours ──┬──► Résultat ──► Dashboard
                          ▲              ▲   │                 │
                          │              │   └─ solde = 0 ──► Achat ──► retour Générateur
                          │              └──── « Réessayer » ◄─┴──► Erreur (FAILED)
                          └── Historique (COMPLETED → Résultat, FAILED → message, en cours → non cliquable)
```

Six écrans, alignés sur les pages existantes (`/auth`, `/dashboard`, `/generate`, `/generating/[id]`, `/result/[id]`, `/buy`). La route de retour du magic link (`/auth/callback`) est technique, ce n'est pas un écran.

Règles de flux :
- Le flux est linéaire : `/result/[id]` n'est accessible que pour une génération `COMPLETED` **appartenant à l'utilisateur connecté** ; sinon redirection vers le Dashboard.
- Le texte saisi n'est jamais perdu : ni au passage par `/buy`, ni après un échec.
- Depuis l'écran « En cours », l'utilisateur peut quitter : la génération continue et reste visible dans l'historique.

---

## 3. Input contract — `POST /generations`

### 3.1 Requête

| Élément | Contrat |
|---|---|
| Authentification | JWT Bearer obligatoire. **`userId` est déduit du token, jamais lu dans le body** (le code develop le lit dans le body). |
| Body | `{ "sourceText": string }` — **aucun autre champ**. |
| Ce que l'utilisateur fournit | Uniquement le texte. Tout le reste (nombre de slides, ton, langue, template) est automatique. |

### 3.2 Validations (serveur = autorité ; UX = miroir exact)

| Règle | Valeur | Visible côté UX |
|---|---|---|
| Unité de mesure | **Mots** : `text.trim().split(/\s+/).filter(Boolean).length` | Compteur « n / 3000 mots » en temps réel (debounce 150 ms) |
| Minimum | **80 mots** (D-01) | Rouge + « Ajoutez encore {80−n} mots », bouton désactivé |
| Maximum | **3000 mots** | Rouge + « Réduisez de {n−3000} mots », bouton désactivé |
| Texte vide / espaces | Rejeté (0 mot) | Même message que « trop court » |
| Solde | ≥ 1 (somme du ledger) | Bouton remplacé par « Acheter des crédits » ; texte conservé |
| Génération en cours | Une seule par utilisateur (D-03) | Message « Une génération est déjà en cours » + lien vers son écran de suivi |

**Piège à corriger** : `GenerationInputSchema` utilise `z.string().min(80).max(3000)`, qui mesure des **caractères**. Un texte de 800 mots (~5 000 caractères) serait rejeté. La règle doit compter des **mots**, avec **la même fonction** côté client et serveur (à placer dans `@slideify/shared`), sinon un texte « valide » à l'écran peut être refusé par l'API.

Le texte n'est ni nettoyé ni reformaté à la saisie. Un texte incohérent mais dans les bornes n'est pas bloqué : c'est le pipeline IA qui réussit ou échoue proprement.

### 3.3 Effets

1. Création de `Generation` (`status = QUEUED`, `sourceText` immuable).
2. Mise en file BullMQ (le contrôleur develop ne le fait pas).
3. **Aucun mouvement de crédit.**
4. Réponse immédiate, sans attendre le worker.

### 3.4 Réponses

| Cas | Réponse | Code stable |
|---|---|---|
| Succès | `{ generationId, status: "QUEUED" }` | — |
| Non authentifié | Erreur d'authentification | `UNAUTHENTICATED` |
| Texte < 80 mots | Erreur de validation, avec le nombre de mots manquants | `INPUT_TOO_SHORT` |
| Texte > 3000 mots | Erreur de validation, avec le nombre de mots en trop | `INPUT_TOO_LONG` |
| Solde ≤ 0 | Erreur distincte, lisible par le front | `NO_CREDITS` |
| Génération déjà en cours | Erreur distincte, avec l'`id` de la génération en cours | `GENERATION_IN_PROGRESS` |

Les statuts HTTP sont laissés à OpenCode. Exigence produit : le front doit pouvoir distinguer ces cas **sans parser un message texte**. Aujourd'hui `NO_CREDITS` revient en HTTP 200 dans un objet `{ error }` et la page `/generate` l'ignore silencieusement (l'utilisateur ne voit rien) : à traiter en redirection vers `/buy`.

---

## 4. Generation states

### 4.1 États persistés (ratifiés M003)

`QUEUED → PROCESSING_LLM → PROCESSING_RENDER → COMPLETED`, avec `FAILED` atteignable depuis n'importe quel état non terminal. Aucun retour en arrière. Pas d'annulation utilisateur.

**`VALIDATING` : non.** La validation de la réponse IA (JSON, schéma, bornes, troncature) est une étape interne, de quelques millisecondes, incluse dans `PROCESSING_LLM`. L'exposer créerait un quatrième libellé sans valeur pour l'utilisateur et un état de plus à maintenir.

**Règle de persistance** : le statut est écrit **avant** le début de l'étape qu'il décrit. Le code develop ne passe jamais à `PROCESSING_RENDER` (et `GENERATION_LIFECYCLE.md` §Transition 2 place la mise à jour après l'appel de rendu) : le libellé « Mise en page du carrousel… » ne s'afficherait jamais.

### 4.2 Ce que voit l'utilisateur

| État | Écran | Libellé | Actions | Durée typique |
|---|---|---|---|---|
| `QUEUED` | « En cours » | « Préparation… » | Quitter possible | 0–5 s |
| `PROCESSING_LLM` | « En cours » | « Analyse du contenu… » | Quitter possible | 1–5 s (réel), 2–8 s (mock simulé) |
| `PROCESSING_RENDER` | « En cours » | « Mise en page du carrousel… » | Quitter possible | 3–10 s |
| `COMPLETED` | Redirection automatique vers Résultat | — | — | — |
| `FAILED` | Écran d'erreur (§6) | Message traduit | « Réessayer » | — |

Un spinner + le libellé suffisent : pas de barre de progression, pas de pourcentage.

### 4.3 Règles de suivi

- **Plafond global de 90 s** entre la création et un état terminal, toutes étapes cumulées (LLM + rendu + upload), pas 90 s par étape. Au-delà : `FAILED / TIMEOUT`. Les trois définitions actuelles du timeout (V2, `GENERATION_LIFECYCLE.md`, `AI_CONTRACT.md`) sont alignées sur celle-ci. Aujourd'hui aucun timeout n'est implémenté : une génération peut rester `QUEUED` indéfiniment.
- **Polling toutes les 2 s**, arrêté à `COMPLETED` ou `FAILED`.
- **Pas de chargement infini** : si le suivi dépasse 120 s côté client, ou après 3 échecs réseau consécutifs, afficher « La génération continue en arrière-plan — retrouvez-la dans votre historique » avec un lien vers le Dashboard. Le code develop ignore les erreurs de polling en silence.
- **Lecture du statut** : un seul endpoint, `GET /generations/:id` (chemin de `MILESTONE_003.md`, à aligner avec le front qui appelle `/status`), réservé au propriétaire de la génération. Il retourne : `id`, `status`, `createdAt`, `slideCount` (si connu), `error` (code, si `FAILED`) et, si `COMPLETED`, la liste des fichiers (§5.4). Le même endpoint sert au polling et à l'écran Résultat.

---

## 5. Result contract

### 5.1 Résultat attendu d'une génération réussie

Pour une génération `COMPLETED`, l'utilisateur dispose de :

| Artefact | Contrat |
|---|---|
| **Slides** | N slides, **5 ≤ N ≤ 10**, ordonnées 1..N sans trou. Chacune : titre ≤ 60 caractères, corps ≤ 220 caractères. La 1re est une accroche, la dernière une conclusion ou un appel à l'action (intention du prompt, non bloquante). |
| **Images** | Une image PNG **1080×1350 (4:5)** par slide, rendue avec l'unique template. |
| **ZIP** | Contient les N PNG nommés `slide-01.png` … `slide-NN.png` (1-based, sur 2 chiffres). Les clés de stockage internes en base 0 (`slide_0.png`) ne doivent pas fuiter dans le ZIP. |
| **PDF** | **N pages**, une slide par page, dans l'ordre, **même format 4:5 que les PNG, sans marge**. Le `renderPDF` develop ne rend que la 1re slide et en A4 : non conforme. |
| **Langue** | Les slides sont rédigées dans la langue du texte source (D-08). |

ZIP et PDF sont **obligatoires** au MVP (P0). `GENERATION_LIFECYCLE.md` les qualifie d'« optionnels » : c'est incompatible avec `PRODUCT_SPEC_V2.md` §2, qui prévaut.

### 5.2 Information affichée sur l'écran Résultat

- Aperçu de **chaque slide sous forme de l'image réellement téléchargée** (le rendu PNG, pas un rendu HTML séparé : ce que l'utilisateur voit est ce qu'il publie). La page develop affiche des slides factices en dur.
- Position « n / N » et navigation précédent/suivant (flèches ou swipe).
- Boutons **« Télécharger les images (ZIP) »** et **« Télécharger le PDF »**. Ils n'ont aujourd'hui aucun `href`.
- Solde de crédits à jour (l'écran affiche le solde **après** débit).
- Lien de retour vers le Dashboard.

Non requis au MVP : texte des slides en clair, copie de texte, édition, partage, légendes/hashtags.

### 5.3 Exigence de lisibilité (qualité perçue)

Une image 1080 px de large est affichée à environ 360–390 px sur mobile (échelle ≈ 0,35). Le template develop utilise un corps à **18 px** et un titre à **36 px**, soit environ 6 px et 13 px à l'écran : illisible. Le contrat de qualité du template : **corps ≥ 40 px, titre ≥ 64 px** sur le canevas 1080×1350. Vérification : 220 caractères à 40 px sur ~800 px de large tiennent en 5–6 lignes (~340 px de haut) sur 1350 px disponibles ; les bornes de caractères sont donc compatibles avec cette taille.

### 5.4 Fichiers exposés par l'API

Pour une génération `COMPLETED`, l'API doit fournir : la liste **ordonnée** des slides (index 1..N + URL de l'image), l'URL du ZIP, l'URL du PDF. Un lien expiré est régénéré silencieusement (jamais présenté comme une erreur). Aucun fichier n'est supprimé en MVP. Point ouvert bloquant : le modèle `Output` n'a pas de champ d'ordre (D-02).

---

## 6. Error UX

### 6.1 Principes

1. **Aucun code technique n'est jamais affiché.** Le Dashboard develop affiche `Échec : LLM_ERROR` et la page de suivi fait `alert("Erreur : LLM_ERROR")`.
2. Toute erreur de génération est accompagnée de « Aucun crédit n'a été débité. » et d'un unique bouton **« Réessayer »**.
3. « Réessayer » ramène à `/generate` **avec le texte d'origine pré-rempli** (le code develop le perd).
4. Aucune relance automatique, aucune re-génération depuis l'historique : l'utilisateur repart du générateur.
5. Tout code inconnu ou absent tombe sur le message générique.

### 6.2 Codes canoniques (ratifiés M003) et messages

| Code (`Generation.error` / API) | Alias V2 (obsolète) | Message affiché | Bouton |
|---|---|---|---|
| `INPUT_TOO_SHORT` | `ERR_INPUT_TOO_SHORT` | « Ajoutez encore {n} mots. » (bloqué en amont dans le cas nominal) | — |
| `INPUT_TOO_LONG` | `ERR_INPUT_TOO_LONG` | « Réduisez de {n} mots. » (idem) | — |
| `NO_CREDITS` | `ERR_NO_CREDIT` | « Vous n'avez plus de crédits disponibles. » | Acheter des crédits |
| `GENERATION_IN_PROGRESS` | — (nouveau, D-03) | « Une génération est déjà en cours. » | Voir sa progression |
| `LLM_ERROR` | `ERR_AI_TIMEOUT` (partiel) | « Une erreur est survenue pendant l'analyse de votre texte. Réessayez. » | Réessayer |
| `INVALID_RESPONSE` | `ERR_AI_INVALID_RESPONSE` | (même message) | Réessayer |
| `MALFORMED_OUTPUT` (et `TOO_MANY_SLIDES`, à fusionner dedans) | `ERR_AI_SCHEMA_INVALID` | (même message) | Réessayer |
| `TIMEOUT` | `ERR_AI_TIMEOUT` | « La génération prend plus de temps que prévu. Réessayez. » | Réessayer |
| `RENDER_ERROR` | `ERR_RENDER_FAILED` | « Une erreur est survenue pendant la mise en page de votre carrousel. Réessayez. » | Réessayer |
| `STORAGE_ERROR` | `ERR_STORAGE_FAILED` | « Une erreur est survenue pendant l'enregistrement de votre carrousel. Réessayez. » | Réessayer |
| autre / vide | — | « Une erreur est survenue. Réessayez. » | Réessayer |
| — (lien expiré) | `ERR_LINK_EXPIRED` | Aucun : régénération silencieuse | — |

Les codes de paiement (`ERR_PAYMENT_SESSION_FAILED` de la V2) sont hors du flow Generation et non revus ici.

Trois messages distincts pour trois familles (analyse / mise en page / enregistrement) : l'utilisateur n'a pas besoin de distinguer `LLM_ERROR`, `INVALID_RESPONSE` et `MALFORMED_OUTPUT`.

### 6.3 Quand le provider échoue

1. Erreur réseau, quota, timeout ou réponse inutilisable du provider → le worker passe la génération à `FAILED` avec le code ci-dessus. Le provider n'est jamais appelé plus de deux fois pour une même génération (appel initial + **un seul** retry silencieux, uniquement si le JSON est inparsable, avec le prompt de correction).
2. Le retry est invisible : le statut reste `PROCESSING_LLM`, le plafond global de 90 s continue de courir.
3. L'écran de suivi bascule sur l'écran d'erreur : message (§6.2), « Aucun crédit n'a été débité », « Réessayer ».
4. Le Dashboard montre la carte « Échec » avec le même message traduit (jamais le code).
5. Aucun débit n'a eu lieu, donc aucun remboursement à gérer.

### 6.4 Testabilité sans budget

Les états de chargement et d'erreur ne sont vérifiables que si le `MockProvider` les produit. Le mock develop ne le fait pas : il répond instantanément et ne peut jamais échouer, donc `PROCESSING_LLM` est invisible et aucun chemin d'erreur ne s'exerce. Exigences produit (spécifiées dans `AI_PROMPT_SPEC.md` §4) : latence simulée de 2 à 8 s, et marqueurs `__MOCK_TIMEOUT__`, `__MOCK_INVALID_JSON__`, `__MOCK_SCHEMA_INVALID__` pour déclencher `TIMEOUT`, `INVALID_RESPONSE`, `MALFORMED_OUTPUT`. Sans eux, la recette des critères de `ACCEPTANCE.md` sur les erreurs est impossible.

---

## 7. Credit UX

| Sujet | Contrat |
|---|---|
| **Moment du débit** | Exactement −1, **dans la même transaction que le passage à `COMPLETED`**, une fois PNG, ZIP et PDF stockés. Ni à la création, ni en file, ni au retour du LLM, ni après le rendu seul. |
| **Sur `FAILED`** | Aucun débit. |
| **Invariant testable** | Par utilisateur : nombre de générations `COMPLETED` = nombre de `GENERATION_DEBIT` référencés sur ces générations. Jamais deux débits pour une même génération. |
| **Solde** | Somme du ledger (append-only). Jamais un compteur, jamais « le dernier grant » (c'est ce que fait `authenticateWithMagicLink` pour un utilisateur existant). |
| **Affichage** | Pastille de crédits visible sur Dashboard, Générateur et Résultat, rafraîchie après un `COMPLETED`. |
| **Free plan** | 3 crédits, une seule fois par compte, pas de renouvellement, aucune limite fonctionnelle supplémentaire. Attribués à la **première vérification du lien** (D-11). |
| **Solde à 0** | Sur `/generate` : bouton remplacé par « Acheter des crédits », texte conservé. |
| **Achat** | Pack unique de 20 crédits (contrat V2 ; prix : D-12), paiement unique, crédits ajoutés au ledger sur `checkout.session.completed`, idempotent. |
| **Concurrence** | Une seule génération en cours par utilisateur (D-03), ce qui empêche un solde négatif (double-clic, deux onglets) sans mécanisme de réservation. |

---

## 8. Activation

- **Définition** : la première génération `COMPLETED` d'un compte. C'est la réception d'un résultat, pas l'inscription ni le simple lancement.
- **Événement** : `user_activated`, émis une seule fois par utilisateur, dans la même transaction que le passage à `COMPLETED`, avec l'id de la génération en métadonnée. `first_generation_completed` désigne le même instant : un seul des deux doit exister (D-07).
- **Événements MVP** : `user_activated` et `download_clicked` (type `zip` ou `pdf`). Les autres événements de la V2 §13 (`signup_*`, `generation_started`, `generation_failed`, `checkout_*`) sont **déjà dérivables** des tables `User`, `Generation` et `CreditTransaction` : on ne les journalise pas. Simplification par rapport à la V2.
- Aucun outil d'analytics tiers.

---

## 9. MVP scope (nécessaire pour le flow Generation)

**Générateur** : textarea unique, compteur de mots, messages min/max, bouton désactivé hors bornes, bascule « Acheter » à 0 crédit, texte préservé.
**API** : `POST /generations` selon §3 (JWT, validation en mots, contrôle du solde, une génération en cours, mise en file) ; `GET /generations/:id` (propriétaire uniquement) ; `GET /generations` (historique, plus récent en premier).
**Pipeline** : états §4, plafond 90 s, validation IA (5–10 slides, ≤ 60 / ≤ 220 caractères, troncature du titre et du corps, ordre continu, un retry sur JSON inparsable), rendu 1080×1350, ZIP, PDF de N pages, stockage, débit atomique à `COMPLETED`.
**Suivi** : écran « En cours » avec 3 libellés, polling 2 s, gardes anti-chargement infini.
**Résultat** : aperçu des PNG, navigation, 2 téléchargements, solde à jour.
**Erreurs** : table §6.2, jamais de code brut, « Réessayer » avec texte conservé.
**Historique** : date, statut (« En cours » / « Terminé » / « Échec » — plus les valeurs brutes en minuscules), lien vers le résultat si `COMPLETED`, message traduit si `FAILED`, état vide avec CTA. La vignette de la 1re slide est prévue en V2 ; **si un arbitrage de délai est nécessaire, c'est le premier élément à retirer**.
**IA** : `MockProvider` par défaut hors production, avec latence simulée et marqueurs d'échec ; `OpenRouterProvider` activé uniquement en production.
**Activation** : `user_activated`, `download_clicked`.

---

## 10. Out of scope

Import par URL · upload de fichier · choix de template · légendes et hashtags · édition ou réordonnancement des slides · annulation d'une génération en cours · suppression d'historique · pagination avancée au-delà de la liste simple · notification par email de fin de génération · barre de progression · websocket · partage par lien · changement de nombre de slides ou de ton · abonnement · marque personnalisée · analytics tiers · métriques Prometheus et alerting de `GENERATION_LIFECYCLE.md` (sujet d'exploitation, pas produit) · types de ledger `REFUND`, `PROMO`, `ADJUSTMENT` (présents dans l'enum, sans écran ni flux au MVP).

---

## 11. Cohérence M003 et ambiguïtés

### 11.1 Verdict

Les invariants produit sont **cohérents** entre V2, docs M003 et intention du code : ledger append-only, débit à `COMPLETED`, aucun débit sur `FAILED`, 5–10 slides, bornes de 60/220 caractères, MockProvider par défaut, 3 crédits gratuits, une seule génération = un seul débit. Les divergences portent sur les noms, le modèle de données et quelques règles de validation.

### 11.2 Matrice

| Sujet | V2 | Docs M003 | Code develop | Résolution |
|---|---|---|---|---|
| Noms d'états | `PROCESSING_AI`, `RENDERING` | `PROCESSING_LLM`, `PROCESSING_RENDER` | idem M003 (jamais écrit pour le rendu) | ✅ M003 ratifié |
| Codes d'erreur | `ERR_*` | `LLM_ERROR`, `INVALID_RESPONSE`, `MALFORMED_OUTPUT`, `TIMEOUT`, `RENDER_ERROR`, `STORAGE_ERROR` | idem + `TOO_MANY_SLIDES`, `NO_CREDITS` | ✅ M003 ratifié (§6.2) |
| Types de ledger | `GRANT_FREE`, `PURCHASE`, `CONSUMPTION` | `GENERATION_DEBIT`, `REFUND`, `MANUAL_GRANT`, `PROMO`, `ADJUSTMENT` | idem ; achat écrit en `MANUAL_GRANT` | ⚠️ D-06 |
| Minimum de mots | 50 | 80 (« 3 mots » en faute de frappe dans `MILESTONE_003`) | 80 (mesuré en caractères) | ⚠️ D-01 |
| Persistance des slides | table `Slide` | pas de `Slide`, `Output` sans ordre | — | ❌ D-02 |
| Génération en parallèle | non traité | « à éviter, dedupe » | non traité | ⚠️ D-03 |
| Troncature du titre | titre et corps tronqués | corps tronqué, titre > 60 → échec | aucune | ⚠️ D-04 |
| `source_language` | informatif | « informatif » mais Zod `.length(2)` bloquant | non validé | ⚠️ D-05 |
| Événement d'activation | `generation_activated` | `user_activated` et `first_generation_completed` | — | ⚠️ D-07 |
| Langue de sortie | non précisée | « pas de langue forcée » | prompt en français | ❌ D-08 |
| Sélection du provider | variable `AI_PROVIDER` | mock si clé absente, repli vers mock si erreur | mock si clé absente | ⚠️ D-09 |
| Achat avec solde > 0 | non interdit | — | refusé (`ALREADY_HAS_CREDITS`) | ⚠️ D-10 |
| Crédits gratuits | à la 1re connexion | après `/auth/verify` | accordés dès `POST /auth/magic-link` | ⚠️ D-11 |
| Retry sur schéma absent | terminal | retry (§2) mais terminal (diagramme) | aucun retry | ⚠️ D-14 |
| ZIP / PDF | P0 | « optionnel » | PDF 1 page A4, ZIP absent | ✅ V2 prévaut (§5.1) |
| Timeout 90 s | global | 3 définitions | absent | ✅ global (§4.3) |
| Débit transactionnel à `COMPLETED` | oui | oui | oui, mais `userId` peut valoir `''` | ✅ 🔎 |
| Auth JWT | magic link | `/auth/verify` + guard | `userId` dans le body | 🔎 D-13 |
| Enqueue au `POST` | oui | oui | absent | 🔎 D-13 |

### 11.3 Registre des décisions et ambiguïtés

**Comment lire** : *Défaut* = ce qu'OpenCode applique sans réponse du owner. *Bloquant* = ne pas implémenter sans réponse.

| ID | Sujet | Contexte | Défaut / Recommandation | Statut |
|---|---|---|---|---|
| **D-01** | Minimum de mots | V2 = 50 ; code, DoD M003 et UX = 80. 50 mots ne remplissent pas 5 slides sans remplissage artificiel. | **80 mots**, compté en mots (pas en caractères). Alignement documentaire requis (§12). | Ratifié — validation owner souhaitée |
| **D-02** | Ordre et contenu des slides pour l'écran Résultat | `Output` n'a pas d'index de slide ; pas de table `Slide`. Le Résultat doit afficher N images ordonnées. | Ajouter un index de slide (1-based) sur les `Output` PNG ; pas de table `Slide` au MVP ; le texte des slides n'est pas exposé. Toute autre solution qui fournit une liste ordonnée est acceptable. | **Bloquant** pour l'écran Résultat |
| **D-03** | Une génération en cours par utilisateur | Le double-clic ou deux onglets créent deux jobs et un solde de −1. | Refuser un nouveau `POST` tant qu'une génération est en `QUEUED` / `PROCESSING_*` (`GENERATION_IN_PROGRESS`). Suppose que le plafond 90 s sorte réellement les jobs bloqués. | À valider owner |
| **D-04** | Titre > 60 caractères | Les LLM dépassent souvent d'un ou deux caractères ; échouer coûte une génération pour rien. | **Tronquer titre et corps** au dernier mot complet + ellipse. Échec seulement si nombre de slides hors 5–10 ou ordre incohérent. | V2 prévaut |
| **D-05** | `source_language` | Champ informatif, mais `z.string().min(2).max(2)` fait échouer la génération sur `"fr-FR"` ou `"French"`. | Ne jamais faire échouer sur ce champ : normaliser (2 lettres) ou ignorer. | Défaut |
| **D-06** | Distinguer achat et grant | Un achat Stripe et le bonus d'inscription sont tous deux `MANUAL_GRANT`. | Ajouter un type `PURCHASE` (référence = id de session Stripe). Bonus d'inscription : `MANUAL_GRANT`, référence `signup_bonus`. | À valider owner (modif d'enum) |
| **D-07** | Nom de l'événement d'activation | Deux noms pour le même instant ; `GenerationEvent` n'a pas de `generationId` alors que `DOMAIN_MODEL.md` relie `Generation` 1..N `GenerationEvent`. | Un seul événement `user_activated`, id de génération en métadonnée. Retirer `first_generation_completed`. | Défaut |
| **D-08** | Langue de sortie | Le prompt système est en français, aucune consigne de langue : un texte anglais peut ressortir en français. | Ajouter au prompt système : « Rédige les slides dans la même langue que le texte source. » | Défaut — lacune de ma V2 |
| **D-09** | MockProvider en production | Clé absente ou erreur OpenRouter → mock silencieux : l'utilisateur payant reçoit du texte tronqué et son crédit est débité. | En production : démarrage refusé si la clé est absente ; aucun repli vers le mock. En dev/test : mock par défaut. | Défaut |
| **D-10** | Achat avec solde > 0 | Le checkout refuse tant que le solde est positif : un utilisateur à 1 crédit ne peut pas recharger. Non spécifié en V2. | Autoriser l'achat à tout solde ; lien depuis la pastille de crédits. | À valider owner |
| **D-11** | Moment des crédits gratuits | Le code accorde 3 crédits dès la saisie d'un email quelconque, sans vérification : n'importe qui peut multiplier les crédits gratuits. | Accorder à la **première vérification du lien magique** (`/auth/verify`), une fois par compte. | Défaut (V2 §11) |
| **D-12** | Prix, pack, disponibilité de paiement | Le code affiche 20 crédits à 9,90 € avec 19,90 € barré « lancement » : ni prix ni promotion ne figurent dans une spec. Par ailleurs, la disponibilité de Stripe dépend du pays de l'entité qui encaisse. | Pack de 20 crédits, prix en configuration, **pas de prix barré** tant que non validé. Le owner confirme prix et faisabilité du paiement pour son entité. | **À trancher par le owner** (hors flow Generation, conditionne la monétisation V1) |
| **D-13** | Code M003 absent du remote | Voir §0. | Pousser la branche M003, ou confirmer où elle se trouve. Les lignes 🔎 sont à re-vérifier. | **Bloquant** pour clore la vérification |
| **D-14** | Retry sur schéma manquant | `AI_CONTRACT.md` §2 dit retry, son propre diagramme dit échec terminal. | Retry uniquement sur JSON inparsable (V2). | Défaut |

---

## 12. Annexe — Écarts de `develop@0c6775c` avec ce contrat (visibles côté produit)

À traiter en M004 si non déjà corrigés dans M003 (🔎) :

| Écart | Effet utilisateur | Réf. |
|---|---|---|
| `POST /generations` ne met rien en file | La génération reste `QUEUED` pour toujours | §3.3 |
| Aucun timeout | Spinner infini | §4.3 |
| Statut `PROCESSING_RENDER` jamais écrit | Libellé « Mise en page » jamais affiché | §4.1 |
| Validation en caractères, non appliquée | Textes valides refusés ou textes invalides acceptés | §3.2 |
| Réponse `NO_CREDITS` ignorée par `/generate` | Le clic ne fait rien | §3.4 |
| `alert("Erreur : LLM_ERROR")`, `Échec : LLM_ERROR` | Code technique affiché | §6.1 |
| Texte perdu après échec | L'utilisateur doit tout recoller | §6.1 |
| Résultat, historique et solde en données factices | Aucun contenu réel affiché | §5.2, §9 |
| Boutons de téléchargement sans action | Aucun téléchargement possible | §5.2 |
| PDF 1 page A4 ; ZIP absent | Livrable incomplet | §5.1 |
| Corps 18 px / titre 36 px | Illisible sur mobile | §5.3 |
| MockProvider sans latence ni marqueurs d'échec | États de chargement et d'erreur non testables | §6.4 |
| Job de queue transporte `sourceText` (V2 : `generationId` seul) | Mineur, texte dupliqué dans Redis | — |
| `GET /generations/:id/status` sans contrôle de propriétaire | Un utilisateur peut lire l'état d'une génération d'autrui | §4.3 |

### Alignement documentaire à faire après validation (non fait dans cette revue)

`PRODUCT_SPEC_V2.md` §4, §7-8, §13 (bornes, codes, événements) · `UX_FLOW.md` §2, §3 (message min, codes) · `AI_PROMPT_SPEC.md` §2, §4, §5 (langue, titre, marqueurs) · `GENERATION_SPEC.md` §1, §3 (états, `Slide`, ledger) · `ACCEPTANCE.md` (80 mots, codes M003) · `MILESTONE_003.md` (« 3 mot min »).
