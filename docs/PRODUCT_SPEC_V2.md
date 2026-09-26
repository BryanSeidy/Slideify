# PRODUCT_SPEC_V2.md

## Statut de ce document

Version consolidée et exécutable des décisions produit. Ce document est **auto-suffisant** : OpenCode ne devrait pas avoir besoin d'interpréter une intention non écrite ici. Il supersede la partie "produit" de `docs/PRODUCT.md` (V1) sur les points où il est plus précis ; `docs/PRODUCT.md` reste valide pour le narratif de vision. `docs/UX.md`, `docs/ACCEPTANCE.md`, `docs/BACKLOG.md` (V1) restent en vigueur et sont complétés par `UX_FLOW.md`, `GENERATION_SPEC.md`, `AI_PROMPT_SPEC.md` (V2) pour le détail d'exécution.

**Contrainte transverse non négociable : budget 0€ pendant tout le développement.** Aucun appel à une API payante (LLM réel, storage payant au-delà des tiers gratuits, service de paiement en mode réel) ne doit être fait pendant l'implémentation. Le produit doit être **entièrement fonctionnel et démontrable avec le Mock AI Provider** (cf. `AI_PROMPT_SPEC.md`). Le provider réel (OpenRouter) et le mode paiement réel (Stripe live) ne sont activés qu'à la mise en production, sur décision explicite, jamais par défaut.

---

## 1. User Journey complet

Parcours de bout en bout, au-delà du seul flux de génération (déjà couvert par `UX_FLOW.md`) :

1. **Découverte** — l'utilisateur arrive sur la landing (hors périmètre de ce document : landing marketing = P1/growth, pas un blocker MVP techniquement, mais l'accès direct à `/app` doit fonctionner sans landing si nécessaire)
2. **Inscription** — email → magic link → compte créé automatiquement avec 3 crédits gratuits (aucune étape d'onboarding, aucun formulaire de profil)
3. **Première intention** — arrivée sur le Dashboard vide, CTA unique "Créer mon premier carrousel"
4. **Première génération (intent)** — saisie du texte, lancement
5. **Moment de vérité (activation)** — réception du premier carrousel généré avec succès. C'est **l'événement d'activation du produit** (voir §13)
6. **Réalisation de valeur** — téléchargement effectif (ZIP ou PDF)
7. **Retour** — l'utilisateur revient pour une seconde génération (signal de rétention)
8. **Épuisement des crédits** — redirection vers l'achat, conversion en client payant
9. **Usage récurrent** — génération répétée, consultation de l'historique

Chaque étape correspond à un événement journalisé (§13, Activation funnel) — même en l'absence d'outil d'analytics tiers (budget 0€), ces événements sont **stockés en base Postgres**, pas dans un service externe.

---

## 2. MVP exact (liste fermée, faisant foi)

Rien n'est implémenté en dehors de cette liste sans mise à jour explicite de ce document.

- [ ] Auth par magic link (Supabase Auth)
- [ ] Attribution automatique de 3 crédits gratuits à l'inscription
- [ ] Écran de saisie de texte brut (unique type d'entrée, voir §4)
- [ ] Validation de bornes de longueur (50 à 3000 mots, voir §4)
- [ ] Génération via pipeline BullMQ → LLMProvider (Mock en dev) → validation → rendu Puppeteer (voir `GENERATION_SPEC.md`)
- [ ] Un seul template visuel de carrousel
- [ ] Export PNG (ZIP) + PDF
- [ ] Stockage des assets (Supabase Storage, tier gratuit)
- [ ] Historique des générations avec statuts (voir `GENERATION_SPEC.md` §Historique)
- [ ] Décompte du crédit uniquement au succès complet d'une génération
- [ ] Achat de crédits via Stripe Checkout (paiement unique, un seul pack proposé)
- [ ] Journalisation des événements d'activation en base (table `events`, voir §13)

**Explicitement exclu du MVP** (rappel, cf. `docs/BACKLOG.md` pour le détail P1/P2) : import URL, légendes/hashtags générés, choix de template, abonnement récurrent, marque personnalisée, édition post-génération, API publique, analytics tiers.

---

## 3. Generation workflow

Détaillé intégralement dans `GENERATION_SPEC.md`. Résumé de référence :

```
Saisie texte → Validation front (bornes) → Création job (statut QUEUED)
  → Worker prend le job (PROCESSING_AI)
  → Appel LLMProvider (Mock ou réel)
  → Validation schéma + bornes de la réponse
  → (RENDERING) Rendu Puppeteer → PNG × N + PDF
  → Upload Supabase Storage
  → (COMPLETED) Décompte crédit + notification client
```

Tout échec à n'importe quelle étape → statut `FAILED` avec un `errorCode` explicite (catalogue exhaustif dans `GENERATION_SPEC.md` et `UX_FLOW.md`), **aucun décompte de crédit**.

---

## 4. Content input types

**P0 — seul type supporté : texte brut collé.**

- Longueur minimale : **50 mots**
- Longueur maximale : **3000 mots**
- Encodage : UTF-8, toute langue acceptée en entrée (le LLM détecte `source_language`, cf. `AI_PROMPT_SPEC.md`) — mais le template visuel n'est validé en MVP que pour du texte latin gauche-à-droite ; les langues RTL sont un cas non testé, non bloqué mais non garanti
- Pas de formatage riche accepté (pas de markdown, pas de HTML) — le texte est traité comme chaîne brute, tout balisage éventuel est ignoré/aplati par le LLM lors de la structuration

**Explicitement non supportés en P0** (aucune UI, aucun endpoint ne doit les exposer) :
- Import par URL
- Upload de fichier (PDF, DOCX, TXT)
- Dictée / transcription audio
- Import depuis un post existant (LinkedIn, etc.)

---

## 5. Carousel slide schema

Voir `GENERATION_SPEC.md` §Schéma de données pour le détail complet (types, contraintes DB). Résumé du contrat structurel :

```
Slide {
  order: integer (1 à N, séquence continue sans trou ni doublon)
  title: string (≤ 60 caractères)
  body: string (≤ 220 caractères)
}
```

`N` (nombre de slides) est **compris entre 5 et 10 inclus**, déterminé automatiquement par le LLM — aucun contrôle utilisateur sur ce nombre en P0.

---

## 6. AI prompt architecture

Détaillé intégralement dans `AI_PROMPT_SPEC.md`. Principe directeur : **le développement se fait à 100% sur `MockProvider`**, zéro appel réseau payant. Le `MockProvider` doit produire une variabilité réaliste (nombre de slides, longueur de texte) pour que le rendu Puppeteer soit testé dans des conditions représentatives sans jamais consommer de quota LLM réel.

---

## 7 & 8. Error states / Loading states

Catalogue canonique unique (utilisé par `GENERATION_SPEC.md` et `UX_FLOW.md`, à implémenter comme constantes partagées côté backend et frontend — pas de chaînes d'erreur dupliquées ou réinventées à l'implémentation) :

### Codes d'erreur (`errorCode`)

| Code | Déclencheur | Crédit décompté ? |
|---|---|---|
| `ERR_INPUT_TOO_SHORT` | Texte < 50 mots | Non (bloqué avant soumission) |
| `ERR_INPUT_TOO_LONG` | Texte > 3000 mots | Non (bloqué avant soumission) |
| `ERR_NO_CREDIT` | 0 crédit au moment de la soumission | Non |
| `ERR_AI_TIMEOUT` | Réponse LLM absente après seuil (90s) | Non |
| `ERR_AI_INVALID_RESPONSE` | JSON invalide après 1 retry (cf. `AI_PROMPT_SPEC.md`) | Non |
| `ERR_AI_SCHEMA_INVALID` | JSON valide mais hors bornes (slide_count hors 5-10, etc.) | Non |
| `ERR_RENDER_FAILED` | Échec Puppeteer | Non |
| `ERR_STORAGE_FAILED` | Échec upload Supabase Storage | Non |
| `ERR_LINK_EXPIRED` | Lien de téléchargement expiré | N/A (post-succès) |
| `ERR_PAYMENT_SESSION_FAILED` | Échec création session Stripe Checkout | N/A |

### États de chargement (`status` de génération)

`QUEUED` → `PROCESSING_AI` → `RENDERING` → `COMPLETED` (ou `FAILED` depuis n'importe quel état intermédiaire)

États d'UI additionnels hors génération : `AUTH_LINK_SENDING`, `HISTORY_LOADING`, `CHECKOUT_SESSION_CREATING`, `ASSET_PREPARING` (attente de disponibilité storage avant activation des boutons de téléchargement).

---

## 9. UX du générateur

Détaillé dans `UX_FLOW.md`. Principe : un seul champ, un seul bouton, feedback en temps réel sur les bornes de longueur, aucune option de configuration.

---

## 10. Historique des générations

Voir `GENERATION_SPEC.md` §Historique pour le modèle de données et la pagination. Règles produit :
- Tri anti-chronologique (plus récent en premier)
- Chaque entrée affiche : vignette (première slide si `COMPLETED`), date, statut
- Aucune suppression d'historique en P0 (pas de bouton "supprimer" — simplicité, et traçabilité des crédits consommés)

---

## 11. Free plan (exact, verrouillé)

- **3 crédits gratuits** attribués automatiquement à la création de compte (déclenché par la première connexion via magic link, pas à l'envoi de l'email)
- **Pas de renouvellement mensuel** — les 3 crédits sont un capital unique, à vie, pour le compte
- Aucune autre limite fonctionnelle sur le free plan (même template, même qualité de rendu, même vitesse de traitement que le plan payant — la seule différence est le nombre de crédits)
  - *Justification* : ne pas dégrader l'expérience du free plan protège la perception qualité dès le premier usage, qui est le critère de succès du MVP (`docs/PRODUCT.md`)

---

## 12. Future paid plans (roadmap, non implémenté)

**Ne pas coder avant validation explicite post-MVP.** Documenté ici uniquement pour que l'architecture de données (table `credits`/`plans`) ne bloque pas leur ajout futur sans migration destructive.

| Plan (roadmap) | Statut |
|---|---|
| Pack de crédits à l'unité (déjà P0, seul mécanisme actif) | **Implémenté en P0** |
| Abonnement mensuel avec crédits inclus | P1 — non implémenté |
| Plan "Agence" (multi-siège, marque personnalisée) | P2 — non implémenté |

La table de crédits doit être conçue comme un **ledger** (transactions append-only : `GRANT_FREE`, `PURCHASE`, `CONSUMPTION`) plutôt qu'un simple compteur, pour permettre l'ajout d'un plan récurrent plus tard sans réécrire le modèle (voir `GENERATION_SPEC.md` §Schéma de données).

---

## 13. Activation funnel

**Événement d'activation retenu** : première génération menée à `COMPLETED` avec succès (pas l'inscription, pas le simple lancement d'une génération — c'est la réception effective d'un résultat qui constitue la preuve de valeur).

### Table `events` (Postgres, zéro coût — pas d'outil d'analytics tiers en P0)

```
Event {
  id: uuid
  userId: uuid
  type: string
  metadata: jsonb (nullable)
  createdAt: timestamp
}
```

### Événements à journaliser (liste fermée pour le MVP)

| `type` | Déclencheur |
|---|---|
| `signup_started` | Email soumis sur l'écran Auth |
| `signup_confirmed` | Premier clic sur un magic link valide |
| `generation_started` | Job créé (statut `QUEUED`) |
| `generation_activated` | Premier passage à `COMPLETED` d'un compte (événement d'activation, ne se déclenche qu'une fois par utilisateur) |
| `generation_completed` | Chaque passage à `COMPLETED` (y compris au-delà du premier) |
| `generation_failed` | Chaque passage à `FAILED`, avec `errorCode` en `metadata` |
| `download_clicked` | Clic sur "Télécharger ZIP" ou "Télécharger PDF", avec le type en `metadata` |
| `checkout_started` | Clic sur "Acheter" sur l'écran Achat |
| `checkout_completed` | Webhook Stripe traité avec succès |

**Aucun dashboard d'analytics n'est requis en P0** — cette table sert de socle de données brutes, exploitable plus tard (P1/P2) sans dette technique de ré-instrumentation.
