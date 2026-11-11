# M006_DECISIONS_AND_LAUNCH.md

**Mission** : M006-PRODUCT — décisions ratifiées + chemin jusqu'à la production
**Auteur** : Claude1 (Product Lead) — **Date** : 2026-11-11
**Destinataires** : OpenCode (implémentation), Claude2 (QA/sécurité), ClaudeCode (release), owner
**Nature** : document de gouvernance produit. Aucun code. Il ferme les décisions ouvertes de M004, corrige une hypothèse de paiement devenue fausse, et fixe les critères de mise en production.

---

## 0. Méthode et précédence

L'owner a demandé de poursuivre jusqu'à la mise en production sans nouvelle consultation. J'applique donc la règle posée en M004 : **toute décision qui avait un défaut est ratifiée avec ce défaut**, révocable par l'owner à tout moment. Seuls les points qui exigent une action de l'owner (compte de paiement, prix) restent ouverts (§7).

**Précédence en cas de conflit entre documents** (du plus fort au plus faible) :
1. `M006` (ce document) → 2. `M005` (rendu) → 3. `M004_PRODUCT_REVIEW` (flow Generation) → 4. `PRODUCT_SPEC_V2`, `GENERATION_SPEC`, `AI_PROMPT_SPEC`, `UX_FLOW` → 5. V1 (`PRODUCT`, `UX`, `PROMPTS`, `ACCEPTANCE`, `BACKLOG`).

Un bandeau de renvoi vers ce document est ajouté en tête des docs 4 et 5 concernés. Leur contenu n'est pas réécrit : la table du §1 liste précisément ce qui est remplacé.

---

## 1. Décisions ratifiées

| ID | Décision finale | Remplace |
|---|---|---|
| D-01 | Minimum **80 mots**, maximum 3000, comptés en **mots** avec une seule fonction partagée client/serveur. | V2 « 50 mots » |
| D-02 | Chaque PNG porte un **index de slide (1-based)** ; l'API renvoie la liste ordonnée. Pas de table `Slide` au MVP, le texte des slides n'est pas exposé. | V2 table `Slide` |
| D-03 | **Une seule génération en cours par utilisateur**, garantie **au niveau base** (pas seulement applicatif). Code : `GENERATION_IN_PROGRESS`. | — |
| D-04 | Titre et corps trop longs sont **tronqués** au dernier mot + ellipse ; échec seulement si nombre de slides hors 5–10 ou ordre incohérent. | `AI_CONTRACT` « titre > 60 → échec » |
| D-05 | `source_language` n'est **jamais bloquant** (normalisé ou ignoré). | Zod `.length(2)` bloquant |
| D-06 | Nouveau type de ledger **`PURCHASE`** (référence = identifiant de transaction du fournisseur de paiement). Bonus d'inscription : `MANUAL_GRANT`, référence `signup_bonus`. | achat écrit en `MANUAL_GRANT` |
| D-07 | Un seul événement d'activation : **`user_activated`** (id de génération en métadonnée). | `generation_activated`, `first_generation_completed` |
| D-08 | Les slides sont rédigées **dans la langue du texte source** (ajout au prompt système). | prompt sans consigne de langue |
| D-09 | En production : **démarrage refusé sans clé du provider IA**, aucun repli silencieux vers le mock. | repli vers mock |
| D-10 | L'achat de crédits est autorisé **quel que soit le solde**. | refus si solde > 0 |
| D-11 | Les 3 crédits gratuits sont accordés à la **première vérification du lien magique**, une fois par compte. | crédits dès la saisie de l'email |
| D-12 | **Remplacée** par D-15 (paiement) et §7 (prix). | « Stripe, 9,90 € barré » |
| D-13 | **Close** : le code M003/M004 est maintenant sur `develop`, mais le red team le déclare NO-GO (il ne compile pas). Voir §3, porte A. | — |
| D-14 | Un seul retry, **uniquement sur JSON inparsable**. | `AI_CONTRACT` §2 ambigu |
| **D-15** | **Fournisseur de paiement** : voir §2. Stripe n'est pas utilisable tel quel. | Stripe Checkout (P0-15) |
| **D-16** | **`PAYMENT_PROVIDER=mock` en développement** (budget 0 €) : simule succès, annulation, échec, webhook en retard. | — |

### Invariants produit non négociables (le mécanisme technique reste à OpenCode)

Chacun doit être garanti **par la base de données**, pas seulement par une vérification applicative — c'est ce que le red team (F-13, F-14, F-15) et la senior review (CF1–CF3, MF3) ont montré comme absent :

1. Un utilisateur ne peut jamais avoir **plus d'une génération en cours**.
2. **Un seul débit par génération `COMPLETED`**, même si le job est rejoué, redémarré ou traité par deux workers.
3. **Un seul crédit par transaction de paiement**, même si le webhook arrive deux fois.
4. Le **solde ne devient jamais négatif**, y compris avec deux requêtes simultanées à solde = 1.
5. Un fichier uploadé sans génération `COMPLETED` ne doit pas rester référencé (pas d'orphelins visibles par l'utilisateur).

---

## 2. D-15 — Paiement : Stripe n'est pas disponible pour une entité au Cameroun

### 2.1 Constat

Mes specs V1/V2 et le code supposaient Stripe Checkout. À la lumière de recherches faites aujourd'hui :

- Stripe n'ouvre des comptes marchands que dans une liste limitée de pays (46 pays pleinement supportés fin 2025), plus un « réseau étendu » via Paystack pour cinq pays africains : Ghana, Kenya, Nigeria, Afrique du Sud, Côte d'Ivoire. **Le Cameroun n'apparaît pas dans ce que j'ai pu lire.** Il apparaît seulement comme pays où *Stripe Tax* calcule des taxes pour des clients, ce qui est autre chose (encaisser vs. calculer une taxe).
- **À confirmer par l'owner sur la page officielle « Stripe Global Availability »** avant d'écarter définitivement : je n'ai pas lu la liste complète des 46 pays, et ma conclusion repose sur son absence dans les extraits consultés.
- Si l'entité qui encaisse est dans un pays supporté (société à l'étranger), Stripe redevient possible, mais cela ajoute une structure juridique et bancaire hors MVP.

### 2.2 Options (niveau produit)

| Option | Ce qu'elle apporte | Réserves |
|---|---|---|
| **Flutterwave** | Licence de paiement au Cameroun (annoncée en juin 2025, avec Ecobank) ; mobile money (dont MTN MoMo), cartes, virements ; liens de paiement ; encaissement possible pour des clients hors Cameroun. | Frais et règlement plus lents que les agrégateurs locaux selon un comparatif d'intégrateur. |
| **Agrégateurs locaux** (Notch Pay, MeSomb, CinetPay, Fapshi) | MTN MoMo + Orange Money ; frais indicatifs 1,5–3,5 %, règlement T+1 à T+3 ; Notch Pay propose les cartes internationales en module additionnel. | Les chiffres viennent de blogs d'intégrateurs : **ordres de grandeur, à vérifier auprès de chaque fournisseur**. Couverture cartes internationales variable. |
| Stripe via entité étrangère | Expérience de référence, Checkout hébergé. | Création d'entité + compte bancaire à l'étranger : hors délai et hors budget MVP. |

### 2.3 Recommandation

1. **Concevoir le paiement derrière une interface `PaymentProvider`**, sur le modèle exact de `LLMProvider` (ADR-007). Le reste du produit (ledger, écrans, événements) ne connaît pas le fournisseur. `.env.example` a déjà des variables génériques (`PAYMENT_PROVIDER`, `PAYMENT_SECRET_KEY`, `PAYMENT_WEBHOOK_SECRET`).
2. **Lancer avec un seul fournisseur**. Si l'audience cible inclut des clients hors Cameroun payant par carte : **Flutterwave**. Si le lancement vise d'abord le marché local mobile money : un agrégateur local (Notch Pay ou MeSomb) est moins cher et plus rapide à encaisser. **Choix et ouverture du compte : owner** (§7).
3. **Délai à anticiper** : l'ouverture d'un compte marchand (vérification de l'entreprise ou de l'identité) peut prendre plusieurs jours. Elle doit démarrer **maintenant**, en parallèle du développement, sinon elle devient le chemin critique de la mise en production.

### 2.4 Contrat produit du paiement (valable pour tout fournisseur)

- **Checkout hébergé par le fournisseur** (page ou lien de paiement) ; aucun formulaire de carte ni de numéro mobile money dans Slideify.
- **Un seul pack** de crédits au lancement ; quantité (20 proposée) et prix : owner (§7). Prix affiché en une seule devise.
- **Crédit uniquement après vérification côté serveur** de la transaction auprès du fournisseur. Ni la redirection du navigateur ni un webhook non vérifié ne suffisent à créditer.
- **Idempotence** : une même transaction ne crédite qu'une fois (invariant 3).
- **Retour utilisateur** : annulation = retour à l'écran Achat sans message d'erreur ; paiement confirmé mais crédit pas encore visible = « Confirmation du paiement en cours… » avec rafraîchissement automatique (comportement déjà fixé en `UX_FLOW.md` §7).
- **Mobile money** : la confirmation peut prendre de quelques secondes à quelques minutes (validation sur le téléphone). L'état « Confirmation en cours » doit donc tolérer plusieurs minutes et proposer un retour au Dashboard ; le crédit apparaît quand la transaction est vérifiée.
- **Échec de paiement** : message « Le paiement n'a pas abouti. Aucun montant n'a été débité. » + bouton « Réessayer ». (Ne pas affirmer « aucun montant débité » si le fournisseur ne le garantit pas : formulation finale à valider avec le fournisseur retenu.)
- **Remboursement** : traité manuellement par l'owner au lancement (écriture `REFUND` dans le ledger, déjà présente dans l'enum). Aucun écran.

### 2.5 `PAYMENT_PROVIDER=mock` (D-16)

Obligatoire pour respecter le budget 0 € et pour tester sans argent réel : le mock doit pouvoir simuler **paiement réussi, annulé, échoué, et confirmation retardée** (par exemple via des montants ou des marqueurs de test), afin que tous les critères d'acceptation du §2.4 soient vérifiables en staging.

---

## 3. Portes de mise en production (go / no-go)

La mise en production exige que **toutes** les portes soient franchies, dans l'ordre. Chaque porte a un propriétaire et une preuve attendue.

### Porte A — Build et exécution (OpenCode, vérifié par Claude2)
- `pnpm install` se termine ; le projet compile ; l'API démarre ; le worker démarre.
- Les findings **CRITICAL** du rapport red team sont fermés **avec preuve d'exécution** (pas seulement « corrigé dans le code ») : F-01 à F-10, F-15, F-21, F-22, F-24, F-27.
- Un test de bout en bout passe avec le mock : `POST /generations` → `COMPLETED` → crédit débité une fois → fichiers téléchargeables.
- **Preuve** : sortie de CI verte + rapport Claude2 « GO build ».

### Porte B — Conformité produit (Claude1 + Claude2)
- Tous les critères de `ACCEPTANCE.md` sont vérifiés **en staging**, en tenant compte des remplacements du §1 (80 mots, codes M003, paiement générique).
- Les chemins d'erreur sont exercés avec les marqueurs du mock : `TIMEOUT`, `INVALID_RESPONSE`, `MALFORMED_OUTPUT`, `RENDER_ERROR`, `STORAGE_ERROR`, plus `NO_CREDITS` et `GENERATION_IN_PROGRESS`.
- Aucun code technique n'apparaît dans l'interface ; « Réessayer » ramène au générateur avec le texte.
- Les 5 invariants du §1 sont démontrés par des tests de concurrence.
- **Preuve** : matrice critère × résultat.

### Porte C — Qualité du résultat (owner juge, avec le vrai provider IA)
- Jeu de **10 textes de référence** : 5 en français, 3 en anglais, 1 de 80 mots, 1 de 3000 mots.
- Chaque texte donne 5 à 10 slides, dans la langue source, sans texte coupé ou débordant, lisibles sur un écran de 390 px, PDF de N pages en 4:5, ZIP de N PNG numérotés.
- **Seuil** : au moins **8 carrousels sur 10 jugés « publiables tels quels »** par l'owner (c'est le critère de succès de `PRODUCT.md`). En dessous, on retravaille le prompt et le template avant tout lancement.
- **Budget** : ce test impose d'appeler le vrai provider IA, donc une dépense minime et ponctuelle. C'est une **décision explicite de l'owner** (§7), à ne pas confondre avec la règle « 0 € pendant le développement ». Vérifier au préalable si un modèle gratuit d'OpenRouter donne un résultat suffisant ; je n'ai pas vérifié leur disponibilité actuelle.

### Porte D — Commercial et légal (owner)
- Compte de paiement **actif**, et **un achat réel de bout en bout** effectué avec un petit montant, suivi d'un remboursement manuel réussi.
- Prix et pack définis (§7).
- Pages minimales publiées : **conditions d'utilisation, politique de confidentialité, politique de remboursement**, et un contact support.
- Les textes collés par les utilisateurs sont envoyés à un fournisseur d'IA tiers : la politique de confidentialité doit le dire.
- Obligations locales de facturation et de protection des données : à vérifier avec un comptable ou un juriste ; je ne peux pas les trancher ici.

### Porte E — Exploitation (ClaudeCode)
- Environnement de production distinct du staging ; variables d'environnement renseignées ; `AI_PROVIDER` et `PAYMENT_PROVIDER` en mode réel ; démarrage refusé si une clé manque (D-09).
- Aucun secret dans le dépôt. Les jetons d'accès qui ont circulé pendant le projet (GitHub, base de données Neon) sont **révoqués et remplacés** avant le lancement.
- Limitation de débit sur l'envoi de liens magiques (protège les crédits gratuits, D-11).
- Sauvegarde de la base ; journaux d'erreurs consultables ; messages d'erreur sans fuite de contenu utilisateur (red team F-19).
- Domaine et HTTPS en place ; liens de téléchargement signés avec expiration.
- Procédure de **retour arrière** documentée (redéployer la version précédente ; désactiver temporairement l'achat ou la génération).
- **Recommandation à décider** : un plafond global journalier de générations, configurable, pour borner la dépense IA en cas d'abus. Non retenu par défaut pour ne pas ajouter de fonctionnalité.

---

## 4. Feuille de route jusqu'à la production

Pas de dates : le calendrier dépend de la vitesse de correction du build (jalon M007) et du délai d'ouverture du compte de paiement.

| Jalon | Contenu | Propriétaire | Sortie attendue |
|---|---|---|---|
| **M006** | Ce document. Ouverture du compte de paiement (démarrage parallèle). | Claude1, owner | Décisions figées ; compte en cours de vérification |
| **M007** | Réparer le build et le pipeline : file réelle, worker, états, délai de 90 s mesuré depuis la création, débit atomique, contraintes en base. | OpenCode | Porte A franchie |
| **M008** | Rendu : template unique 1080×1350, PNG, PDF de N pages, ZIP, stockage. | OpenCode | Contrat M005 respecté |
| **M009** | Front : générateur (compteur de mots), suivi, résultat réel, historique, erreurs traduites, mobile. | OpenCode | Écrans reliés à l'API réelle (l'audit signale qu'ils ne le sont pas) |
| **M010** | Paiement : interface `PaymentProvider`, mock, puis le fournisseur retenu ; écran Achat. | OpenCode | Critères du §2.4 |
| **M011** | Régression QA/sécurité + qualité du résultat avec le vrai provider IA. | Claude2, owner | Portes B et C |
| **M012** | Staging, pages légales, exploitation, achat réel de test. | ClaudeCode, owner | Portes D et E |
| **Lancement doux** | 10 à 20 utilisateurs invités, deux semaines. | Owner | Indicateurs du §5 |
| **Ouverture publique** | Après revue des indicateurs. | Owner | — |

Le front (M009) et le paiement (M010) peuvent avancer en parallèle une fois M007 terminé.

---

## 5. Lancement doux : indicateurs

Les événements viennent de la base (`user_activated`, `download_clicked`, et les tables `Generation` et `CreditTransaction`) ; aucun outil d'analytics tiers.

| Indicateur | Définition | Seuil proposé |
|---|---|---|
| Taux de réussite | Générations `COMPLETED` / générations terminées (`COMPLETED` + `FAILED`) | ≥ 90 % |
| Durée de génération | Médiane création → `COMPLETED` | ≤ 45 s |
| Activation | Comptes vérifiés ayant au moins une génération `COMPLETED` | ≥ 60 % |
| Valeur réalisée | Générations `COMPLETED` suivies d'un téléchargement | ≥ 70 % |
| Conversion | Comptes ayant épuisé leurs 3 crédits et acheté un pack | à observer, pas de seuil (échantillon trop petit) |

Ces seuils sont **mes propositions** pour ouvrir ou non au public ; l'owner peut les ajuster. Si le taux de réussite est sous le seuil, on corrige avant d'ouvrir, même si les autres indicateurs sont bons.

---

## 6. Hors périmètre (rappel)

Tout ce qui figure déjà dans les listes « hors scope » de M004 et M005, plus : plusieurs fournisseurs de paiement simultanés, abonnement, factures PDF automatiques, programme de parrainage, tableau de bord d'analytics.

---

## 7. Décisions réservées à l'owner

| # | Question | Pourquoi je ne peux pas trancher |
|---|---|---|
| O-1 | **Fournisseur de paiement** (Flutterwave, agrégateur local, ou Stripe via entité étrangère) et **ouverture du compte**. | Dépend de l'entité qui encaisse, de l'audience (Cameroun seul ou international) et d'une vérification d'identité que seul l'owner peut faire. |
| O-2 | **Prix et taille du pack**, **devise d'affichage** (FCFA, EUR ou USD). | Dépend du coût réel d'une génération (appel IA) et du pouvoir d'achat de l'audience visée. Le « 9,90 € barré à 19,90 € » du code n'est dans aucune spec : à retirer tant qu'il n'est pas validé. |
| O-3 | **Budget de validation qualité** avec le vrai provider IA (porte C). | Seule dépense prévue avant le lancement. |
| O-4 | **Nom commercial, entité légale, adresse de support** pour les pages légales. | Informations propres à l'owner. |
| O-5 | **Qui juge la porte C** (10 textes) : l'owner lui-même, ou un utilisateur cible. | Le jugement « publiable tel quel » doit venir d'un connaisseur du public cible. |

Tant que O-1 n'est pas tranché, M010 démarre avec le mock : le reste du plan n'est pas bloqué.
