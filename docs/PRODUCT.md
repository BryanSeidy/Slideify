# PRODUCT.md

## Rôle de ce document

Spécification produit de référence. Toute feature développée doit être traçable à une ligne de ce document. Si une fonctionnalité n'y figure pas en P0, elle n'est pas MVP — point final.

---

## Proposition de valeur (resserrée)

**1 contenu → 1 carrousel professionnel, prêt à publier, en moins de 2 minutes.**

On ne vend pas "un outil de repurposing multi-format". On vend **un seul workflow qui marche parfaitement** : coller du texte, obtenir un carrousel design de qualité pro. Tout le reste (URL, multi-templates, légendes, analytics) est un futur palier de valeur, pas une condition du lancement.

## Persona MVP (un seul, volontairement)

**Le créateur de contenu solo** (consultant, freelance, fondateur early-stage) qui :
- publie régulièrement sur LinkedIn/Instagram
- a un texte (post, article, réflexion) mais pas le temps/les compétences design pour le transformer en carrousel
- veut un résultat "qui a l'air fait par un designer", pas un template Canva générique

*Pourquoi un seul persona ?* Servir "créateurs, consultants, entrepreneurs, marketeurs" en même temps dilue le design du template et les critères de qualité. Le template MVP est optimisé pour **du texte à visée professionnelle/éducative** (le cas d'usage du créateur solo). Les autres personas sont un palier de croissance (P2+), pas une contrainte de conception initiale.

## Problème résolu (inchangé, confirmé)

- Le repurposing est chronophage et suppose des compétences design
- Chaque format suppose un outil différent
- Pas de solution qui aille du texte brut à un rendu visuel fini en un clic

## Ce que le MVP fait — et rien d'autre

**Un seul workflow linéaire :**

```
Coller du texte → Générer → Prévisualiser → Télécharger
```

### Entrée (P0)
- **Texte brut collé** (pas d'upload de fichier, pas d'URL)
  - *Justification* : l'extraction d'URL introduit une classe entière de risques (paywalls, JS rendering, contenu mal structuré, temps de scraping variable) incompatible avec un delai de livraison de 2 semaines. Le texte brut couvre 100% du besoin du persona (il a toujours un texte source — post déjà écrit, brouillon, notes).

### Génération (P0)
- Un LLM (via OpenRouter) structure le texte en **slides** : titre de slide + corps court, nombre de slides déterminé automatiquement dans une fourchette bornée (voir PROMPTS.md)
- **Un seul template visuel**, fixe, à haute qualité perçue (typographie soignée, mise en page épurée, branding Slideify discret)
  - *Justification* : le choix de template est un P1. Multiplier les templates au lancement multiplie le travail de design ET la surface de bugs de rendu, pour un gain de conversion incertain à ce stade. Un template excellent bat trois templates moyens.

### Sortie (P0)
- **Images PNG** par slide, format carrousel réseau social (1080×1350), numérotées et téléchargeables en un ZIP
- **PDF** assemblant l'ensemble des slides (même pipeline de rendu Puppeteer que les PNG — coût additionnel marginal, forte valeur perçue "présentation prête")
  - *Justification de l'inclusion du PDF en P0* : le PDF est un sous-produit quasi gratuit du même rendu HTML/CSS que les PNG (une page = un slide). Pas de logique métier additionnelle, juste une sortie de rendu différente.

### Hors périmètre MVP (explicitement)
- Légendes / hashtags générés — **P1** (ajout LLM simple mais nouvelle UI + nouveaux critères de qualité à valider ; protège le scope)
- Choix de template — **P1**
- Import depuis URL — **P1**
- Marque personnalisée (logo, couleurs) — **P2**
- Édition manuelle des slides (drag & drop, réordonner, éditer texte post-génération) — **P2**
- API publique, intégrations sociales directes, analytics — **Future**

## Monétisation dès la V1 (P0)

**Modèle : crédits de génération, non-cumulatifs mensuellement.**

- **Free** : 3 générations offertes à l'inscription (pas de récurrence mensuelle en MVP — trop de logique de reset/cron pour la valeur qu'elle apporte)
- **Pack payant** : achat d'un pack de crédits (ex. 20 générations) via **Stripe Checkout** (paiement unique, pas d'abonnement)
  - *Justification du choix "pack" vs "abonnement"* : un abonnement récurrent impose une gestion de cycle de facturation, de relance d'échec de paiement, de statut actif/inactif — complexité disproportionnée pour un MVP à 2 semaines. Un paiement unique Stripe Checkout est un flux standard, stateless côté métier (on crédite le compte au webhook `checkout.session.completed`).
  - **Stripe est une dépendance à ajouter à la stack cible** (le fichier `.env.example` a déjà les placeholders `PAYMENT_PROVIDER` / `PAYMENT_SECRET_KEY` / `PAYMENT_WEBHOOK_SECRET` — cohérent avec ce choix). C'est un ajout nécessaire, pas une extension de périmètre : sans provider de paiement, "monétisation dès la V1" n'est pas réalisable.
- Génération bloquée à 0 crédit → redirection vers l'écran d'achat (pas de générations "en dette")

## Table MVP / P1 / P2 (mise à jour)

| Priorité | Fonctions |
|---|---|
| **P0 (MVP)** | Auth simple · Texte brut → génération LLM → 1 template fixe · Export PNG (ZIP) + PDF · Historique des générations · Crédits + achat de pack via Stripe |
| **P1** | Import URL · Légendes/hashtags générés · Choix entre 2-3 templates · Abonnement récurrent |
| **P2** | Marque personnalisée · Édition manuelle post-génération · Multi-langue avancé |
| **Future** | API publique · Intégrations sociales (publication directe) · Analytics de performance des posts |

## Critère de succès du MVP

Un utilisateur qui colle un texte de blog LinkedIn typique (300-800 mots) obtient, sans réglage manuel, un carrousel qu'il publierait tel quel — pas "à retoucher".
