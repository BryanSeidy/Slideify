# BACKLOG.md

## Rôle de ce document

Backlog **au niveau feature/produit**, priorisé. Différent de `docs/TASKS.md`, qui suit les tâches d'implémentation technique — chaque item P0 ci-dessous se décompose en une ou plusieurs `TASK-xxx`. Ce document est la source de vérité du **quoi** et du **pourquoi prioriser**, `TASKS.md` reste la source de vérité du **statut d'avancement technique**.

Toute feature ajoutée ici hors P0 doit rester hors périmètre tant que le P0 n'est pas livré et validé. Aucune exception.

---

## P0 — MVP (bloquant pour le lancement)

| # | Feature | Réf. specs | Tâches TASKS.md associées |
|---|---|---|---|
| P0-1 | Authentification par magic link (Supabase Auth) | PRODUCT.md §Ce que le MVP fait, UX.md Écran 1, ACCEPTANCE.md §Authentification | TASK-006 |
| P0-2 | Modèles de données (User, Generation, Credit, Output) | ARCHITECTURE.md, DECISIONS.md ADR-004 | TASK-007 |
| P0-3 | Écran Nouvelle génération : saisie texte + validation bornes | UX.md Écran 3, ACCEPTANCE.md §Saisie et lancement | TASK-012 (dashboard/UI) |
| P0-4 | Queue de génération (BullMQ + Redis) | ARCHITECTURE.md, DECISIONS.md ADR-005 | TASK-008 |
| P0-5 | Interface `LLMProvider` + `MockProvider` conforme au schéma de PROMPTS.md | DECISIONS.md ADR-007, PROMPTS.md | TASK-009 |
| P0-6 | Intégration OpenRouter (provider réel) + prompts système/utilisateur | PROMPTS.md | TASK-009 |
| P0-7 | Validation de la réponse LLM (schéma, bornes, retry, troncature) | PROMPTS.md §Validation, ACCEPTANCE.md §Génération | TASK-009 |
| P0-8 | Template HTML/CSS unique, optimisé pour bornes de PROMPTS.md (titre 60c / corps 220c) | PRODUCT.md §Génération, DECISIONS.md ADR-006 | TASK-011 |
| P0-9 | Rendu Puppeteer → PNG par slide + PDF assemblé | DECISIONS.md ADR-006, ACCEPTANCE.md §Génération | TASK-011 |
| P0-10 | Stockage des assets générés (URLs, expiration/régénération de lien) | ARCHITECTURE.md §Storage | TASK-013 |
| P0-11 | Écran Génération en cours : polling de statut, états d'erreur distincts (timeout / LLM / rendu) | UX.md Écran 4, ACCEPTANCE.md §Génération | TASK-012 |
| P0-12 | Écran Résultat : preview carrousel + téléchargement ZIP + PDF | UX.md Écran 5, ACCEPTANCE.md §Résultat | TASK-012, TASK-013 |
| P0-13 | Dashboard : historique des générations, états (en cours / échec / terminé), état vide | UX.md Écran 2, ACCEPTANCE.md §Historique | TASK-012 |
| P0-14 | Système de crédits : attribution de 3 crédits gratuits à l'inscription, décompte uniquement au succès complet | PRODUCT.md §Monétisation, ACCEPTANCE.md §Crédits | TASK-006, TASK-007 |
| P0-15 | Intégration Stripe Checkout (paiement unique, pas d'abonnement) + webhook idempotent | PRODUCT.md §Monétisation, ACCEPTANCE.md §Crédits | TASK-014 |
| P0-16 | Écran Achat de crédits : offre unique, redirection Stripe, retour et confirmation | UX.md Écran 6, ACCEPTANCE.md §Crédits | TASK-012, TASK-014 |

**Note de dépendance** : Stripe n'apparaît pas dans la stack technique d'origine du README — son ajout est **requis** par PRODUCT.md (monétisation dès V1) et doit être reflété dans `DECISIONS.md` (nouvel ADR) et `.env.example` (déjà présent en placeholder générique `PAYMENT_PROVIDER`) au moment de l'implémentation de P0-15.

---

## P1 (immédiatement après le MVP, pas avant)

| # | Feature | Justification du report |
|---|---|---|
| P1-1 | Import de contenu depuis une URL | Risque d'extraction (paywalls, JS rendering) incompatible avec le délai MVP — cf. PRODUCT.md |
| P1-2 | Génération de légendes/hashtags | Nouvelle UI + nouveaux critères de qualité à valider séparément du carrousel |
| P1-3 | Choix entre 2-3 templates visuels | Le P0 doit d'abord valider qu'**un** template suffit à convaincre |
| P1-4 | Abonnement récurrent (en complément du pack à l'unité) | Complexité de cycle de facturation à ne pas porter avant validation du modèle "pack" |

## P2 (après validation du P1)

| # | Feature |
|---|---|
| P2-1 | Marque personnalisée (logo, couleurs du template) |
| P2-2 | Édition manuelle des slides post-génération (réordonner, éditer texte) |
| P2-3 | Gestion multi-langue avancée |

## Future (non planifié)

| # | Feature |
|---|---|
| F-1 | API publique |
| F-2 | Intégrations de publication directe (LinkedIn, Instagram) |
| F-3 | Analytics de performance des posts publiés |

---

## Règle de gouvernance du backlog

- Aucun item P1/P2/Future ne peut être avancé en P0 sans mise à jour explicite de `PRODUCT.md` justifiant le changement de périmètre (cf. AGENTS.md règle 2 : "Ne pas élargir le scope")
- Le MVP est considéré livrable quand **tous** les items P0 ci-dessus ont leurs critères d'acceptation (`ACCEPTANCE.md`) vérifiés — un sous-ensemble ne suffit pas, le workflow est linéaire et chaque maillon est requis
