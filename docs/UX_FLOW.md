# UX_FLOW.md

> **Mise à jour M006** : certaines règles de ce document sont remplacées par `docs/M006_DECISIONS_AND_LAUNCH.md` (décisions D-01 à D-21, paiement via une interface `PaymentProvider` au lieu de Stripe, format 1080×1350, authentification email + mot de passe). En cas de conflit, M004, M005 et M006 prévalent.

## Statut de ce document

Version d'exécution de `docs/UX.md` (V1). Reprend les 6 écrans déjà définis et les rend **implémentables directement** en liant chaque état d'UI à un code exact (`errorCode` / `status`) défini dans `PRODUCT_SPEC_V2.md` et `GENERATION_SPEC.md`. Aucun texte d'erreur ne doit être inventé à l'implémentation en dehors de la table §3.

---

## 1. Flux canonique

```
Auth (email + mot de passe)
  → Dashboard (historique + CTA nouvelle génération)
    → Générateur (saisie texte)
      → En cours (QUEUED → PROCESSING_AI → RENDERING)
        → Résultat (COMPLETED) → retour Dashboard
        → Erreur (FAILED) → retour Générateur (texte préservé)
    → [si crédits = 0] → Achat (checkout du PaymentProvider) → retour Générateur ou Dashboard
```

Ce flux est strictement linéaire — aucun écran ne doit permettre de sauter une étape (ex. pas d'accès direct à "Résultat" sans passer par une génération réelle).

---

## 1 bis. Écran Auth (M006.1 — remplace `UX.md` Écran 1, qui décrivait un magic link)

L'authentification est **email + mot de passe** (M004.3, ADR-011). **Aucun login par email seul, aucun magic link.**

- **Deux modes sur un même écran** : « Créer un compte » / « Se connecter », bascule par un lien. Champs : email, mot de passe.
- **Validation côté client (miroir du serveur)** : email au format valide ; mot de passe de **8 à 72 octets** (le serveur tronque au-delà de 72 avec bcrypt ; le contrat est aligné sur cette limite).
- **Inscription réussie** : l'API ne renvoie pas de jeton (par conception). Le front enchaîne **automatiquement** la connexion, puis ouvre le Dashboard avec l'indication « 3 crédits offerts ».
- **Chargement** : bouton désactivé avec indicateur pendant l'appel ; pas de double soumission.
- **Messages** (jamais de code technique) :

| `code` | Message |
|---|---|
| `INVALID_INPUT` | « Vérifiez votre email et votre mot de passe (8 caractères minimum). » |
| `EMAIL_TAKEN` | « Un compte existe déjà avec cet email. » + lien « Se connecter » |
| `INVALID_CREDENTIALS` | « Email ou mot de passe incorrect. » (identique que l'email existe ou non) |
| `UNAUTHENTICATED` (session expirée, sur n'importe quel écran) | Redirection vers l'écran Auth avec « Votre session a expiré. Reconnectez-vous. » |
| erreur réseau / autre | « Une erreur est survenue. Réessayez. » |

- **Pas de « Mot de passe oublié »** au lancement doux : la récupération de mot de passe n'existe pas (elle suppose l'envoi d'emails, voir `M006` §4.4 et O-6). Le support (réinitialisation manuelle) est indiqué sur l'écran.

## 2. UX du générateur (détail d'implémentation)

Écran unique, un seul champ, un seul CTA :

- **Champ texte** : `<textarea>`, placeholder `"Collez votre texte ici — article, post, réflexion…"`
- **Compteur de mots** : mis à jour en temps réel (debounce 150ms), affiché sous forme `"{n} mots"`
  - `n < 50` → compteur en rouge, message sous le champ : `"Ajoutez encore {50 - n} mots"`, bouton CTA désactivé
  - `n > 3000` → compteur en rouge, message : `"Réduisez de {n - 3000} mots"`, bouton CTA désactivé
  - `50 ≤ n ≤ 3000` → compteur en gris neutre, bouton CTA actif
- **Bouton CTA** :
  - Texte par défaut : `"Générer mon carrousel"`
  - Si solde crédits = 0 (valeur connue côté client dès le chargement de l'écran, pas besoin d'attendre la soumission) : le bouton est remplacé par `"Acheter des crédits"`, redirigeant vers l'écran Achat — **le champ texte reste rempli et n'est pas perdu** si l'utilisateur revient ensuite
- **Au clic (cas nominal)** : transition immédiate et sans spinner intermédiaire vers l'écran "En cours" — la création du job est suffisamment rapide (insertion DB + enqueue) pour ne pas justifier d'état de chargement dédié sur ce bouton

---

## 3. Catalogue des messages utilisateur par code

Traduction obligatoire de chaque `errorCode` technique (jamais affiché brut) :

| Code | Message affiché à l'utilisateur |
|---|---|
| `ERR_INPUT_TOO_SHORT` | (géré en amont, pas de soumission possible — voir §2) |
| `ERR_INPUT_TOO_LONG` | (géré en amont, pas de soumission possible — voir §2) |
| `ERR_NO_CREDIT` | "Vous n'avez plus de crédits disponibles." (redirection Achat) |
| `ERR_AI_TIMEOUT` | "La génération prend plus de temps que prévu. Réessayez." |
| `ERR_AI_INVALID_RESPONSE` | "Une erreur est survenue pendant l'analyse de votre texte. Réessayez." |
| `ERR_AI_SCHEMA_INVALID` | "Une erreur est survenue pendant l'analyse de votre texte. Réessayez." |
| `ERR_RENDER_FAILED` | "Une erreur est survenue pendant la mise en page de votre carrousel. Réessayez." |
| `ERR_STORAGE_FAILED` | "Une erreur est survenue pendant l'enregistrement de votre carrousel. Réessayez." |
| `ERR_LINK_EXPIRED` | (traité silencieusement — régénération automatique du lien, jamais montré comme erreur à l'utilisateur, cf. `GENERATION_SPEC.md` §4) |
| `ERR_PAYMENT_SESSION_FAILED` | "Impossible de démarrer le paiement. Réessayez dans un instant." |

Chaque message d'erreur affiché doit être accompagné d'un bouton d'action unique et cohérent avec le contexte : `"Réessayer"` (retour à l'écran Générateur, texte préservé) pour toutes les erreurs de génération ; `"Acheter des crédits"` pour `ERR_NO_CREDIT` ; `"Réessayer le paiement"` pour `ERR_PAYMENT_SESSION_FAILED`.

**Aucun crédit n'est jamais décompté sur un état `FAILED`, quel que soit le code — confirmé transversalement dans `GENERATION_SPEC.md` §1.**

---

## 4. Catalogue des libellés de chargement par état

| `status` / état UI | Libellé affiché |
|---|---|
| `QUEUED` | "Préparation…" |
| `PROCESSING_AI` | "Analyse du contenu…" |
| `RENDERING` | "Mise en page du carrousel…" |
| `AUTH_LINK_SENDING` | (bouton en spinner, pas de libellé texte additionnel) |
| `HISTORY_LOADING` | (skeleton loaders sur les cartes, pas de libellé texte) |
| `CHECKOUT_SESSION_CREATING` | (spinner bref avant redirection vers le checkout du fournisseur) |
| `ASSET_PREPARING` | "Préparation des fichiers…" (écran Résultat, avant activation des boutons de téléchargement) |

Polling du statut de génération : intervalle de **2 secondes**, arrêté dès réception de `COMPLETED` ou `FAILED`. Pas de websocket en P0 (complexité non justifiée au volume MVP — le polling à 2s est indiscernable d'un push en pratique pour une génération de quelques secondes à ~1 minute).

---

## 5. Écran Dashboard — règles d'affichage de l'historique

- Génération `QUEUED`/`PROCESSING_AI`/`RENDERING` → carte non cliquable, libellé de chargement correspondant (§4), pas de vignette
- Génération `COMPLETED` → carte cliquable vers l'écran Résultat, vignette = première slide (`order = 1`)
- Génération `FAILED` → carte cliquable vers un affichage du message d'erreur traduit (§3), **pas de bouton de relance automatique** — l'utilisateur doit repasser par l'écran Générateur (évite toute confusion sur un double décompte de crédit)
- État vide (aucune génération) : message d'accroche + CTA `"Créer mon premier carrousel"`, jamais un tableau vide silencieux

---

## 6. Écran Résultat

- Carrousel de preview navigable (flèches ou swipe), rendu à partir des `Slide` en base, dans l'ordre `order`
- Deux boutons : `"Télécharger les images (ZIP)"` (→ `zipUrl`), `"Télécharger le PDF"` (→ `pdfUrl`)
- Si les URLs ne sont pas encore prêtes au chargement de l'écran (rare, race condition upload/affichage) → état `ASSET_PREPARING` (§4) avant activation des boutons
- Chaque clic de téléchargement journalise l'événement `download_clicked` (cf. `PRODUCT_SPEC_V2.md` §13) avec le type (`zip` ou `pdf`) en métadonnée

---

## 7. Écran Achat

- Une seule offre visible (un seul pack de crédits, prix et quantité définis au moment de l'implémentation du paiement — hors périmètre produit de ce document)
- CTA `"Acheter"` → création du paiement chez le fournisseur (checkout hébergé) → redirection
- Retour après annulation du paiement → retour silencieux à l'écran Achat, **aucun message d'erreur** (annulation ≠ échec)
- Retour après paiement confirmé mais webhook pas encore traité → état transitoire `"Confirmation du paiement en cours…"`, rafraîchissement automatique du solde de crédits par polling court (2s, même mécanisme que §4) jusqu'à mise à jour

---

## 8. Ce qui reste hors périmètre (rappel explicite, ne pas ajouter à l'implémentation)

- Pas d'écran de paramètres/profil
- Pas de choix de template
- Pas d'édition post-génération
- Pas de bouton d'annulation de génération en cours
- Pas de suppression d'historique
- Pas de websocket, pas d'outil d'analytics tiers
