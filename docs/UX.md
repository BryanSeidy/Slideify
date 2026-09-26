# UX.md

## Principe directeur

**6 écrans. Pas un de plus.** Chaque écran existe parce qu'une étape du workflow linéaire l'exige. Aucun réglage, aucune option, aucun menu qui ne serait pas strictement nécessaire à "texte → carrousel".

## Cartographie des écrans (P0)

```
[Auth] → [Dashboard] → [Nouvelle génération] → [Génération en cours] → [Résultat] → (si crédits = 0) [Achat]
```

---

### Écran 1 — Auth

**Objectif** : identifier l'utilisateur pour rattacher crédits et historique.
**Utilisateur** : tous.

**Workflow**
1. Champ email unique
2. Envoi d'un magic link (Supabase Auth) — **pas de mot de passe**
   - *Justification* : élimine l'écran "mot de passe oublié", la validation de force de mot de passe, et tout le flux de reset. Un champ, un email, un clic.
3. Redirection automatique vers Dashboard après clic sur le lien

**États**
- *Chargement* : bouton "Envoyer le lien" → spinner inline, bouton désactivé
- *Succès* : message "Lien envoyé à {email}, vérifiez votre boîte de réception" (l'écran reste affiché, pas de redirection avant clic réel)
- *Erreur* : email invalide (validation front avant envoi) ; échec d'envoi (service mail down) → message "Impossible d'envoyer le lien, réessayez dans un instant"

**Edge cases**
- Email déjà utilisé → pas de distinction "connexion" vs "inscription", le magic link gère les deux cas de façon transparente
- Lien expiré (>1h) → page dédiée "Ce lien a expiré, redemandez-en un" avec CTA retour à l'écran Auth
- Double-clic sur "Envoyer" → debounce, un seul envoi

---

### Écran 2 — Dashboard

**Objectif** : point d'entrée post-connexion, accès à l'historique et à une nouvelle génération.
**Utilisateur** : utilisateur connecté.

**Workflow**
1. Liste des générations passées (vignette de la première slide, date, statut)
2. CTA unique et proéminent : **"Nouvelle génération"**
3. Compteur de crédits restants visible en permanence (header)

**États**
- *Chargement* : squelettes de cartes (skeleton loaders) pendant le fetch de l'historique
- *Vide* (aucune génération) : état vide avec message d'accroche + CTA "Créer mon premier carrousel" (pas de liste vide silencieuse)
- *Erreur* : échec de chargement de l'historique → message + bouton "Réessayer" (le CTA "Nouvelle génération" reste utilisable même si l'historique échoue)

**Edge cases**
- Génération encore "en cours" au moment du chargement du dashboard → carte avec statut "En cours" (pas de vignette, pas de clic possible)
- Génération échouée → carte avec statut "Échec" + icône, clic ouvre le détail de l'erreur (pas de re-génération automatique, l'utilisateur relance manuellement depuis "Nouvelle génération" — évite de consommer un crédit sans confirmation explicite)

---

### Écran 3 — Nouvelle génération

**Objectif** : point de saisie unique du contenu source.
**Utilisateur** : utilisateur connecté avec ≥1 crédit.

**Workflow**
1. Une seule zone de texte (textarea), pas de titre de champ superflu, placeholder explicite ("Collez votre texte ici — article, post, réflexion…")
2. Compteur de mots visible, avec bornes min/max affichées
3. Bouton **"Générer mon carrousel"** — actif seulement si le texte est dans la fourchette valide
4. Aucun réglage additionnel (pas de choix de template, pas de nombre de slides — tout est automatique en MVP)

**États**
- *Saisie* : bouton désactivé tant que hors bornes (compteur passe en rouge avec message contextuel : "Ajoutez au moins X mots" / "Réduisez à moins de Y mots")
- *Chargement* : au clic, transition immédiate vers l'écran "Génération en cours" (pas de spinner sur place — le passage d'écran EST le feedback)
- *Erreur* : 0 crédit restant → le bouton est remplacé par un CTA "Acheter des crédits" qui mène à l'écran Achat, la textarea reste éditable pour ne pas perdre la saisie de l'utilisateur

**Edge cases**
- Texte < borne minimale (ex. < 80 mots) → génération bloquée, message explicatif (évite un carrousel de 1 slide sans substance)
- Texte > borne maximale (ex. > 3000 mots) → génération bloquée avec suggestion de raccourcir (protège coût LLM et temps de rendu — pas de troncature silencieuse qui produirait un résultat surprenant)
- Texte non structuré / incohérent (ex. liste de mots-clés sans phrases) → n'est pas bloqué côté UI ; c'est au LLM de gérer ou d'échouer proprement (voir PROMPTS.md et ACCEPTANCE.md)
- Navigation hors de l'écran pendant la saisie → aucune sauvegarde de brouillon en MVP (assumé, pas un besoin identifié pour un texte collé qui existe déjà ailleurs)

---

### Écran 4 — Génération en cours

**Objectif** : transformer l'attente (LLM + rendu Puppeteer, quelques secondes à ~1 minute) en moment de confiance plutôt que de doute.
**Utilisateur** : vient de lancer une génération.

**Workflow**
1. Affichage d'un statut progressif à 2 étapes maximum : "Analyse du contenu…" → "Mise en page du carrousel…"
2. Polling du statut du job BullMQ (ou websocket si disponible dans la stack — sinon polling simple toutes les 2s)
3. Redirection automatique vers l'écran Résultat dès complétion

**États**
- *En file d'attente* (job pas encore pris par le worker) : "Préparation…"
- *En traitement LLM* : "Analyse du contenu…"
- *En rendu* : "Mise en page du carrousel…"
- *Erreur* : voir ci-dessous

**Edge cases**
- Timeout (job bloqué au-delà d'un seuil, ex. 90s) → message d'erreur explicite "La génération prend plus de temps que prévu" + option "Réessayer" (le crédit n'est décompté qu'à la complétion réussie — jamais à la mise en file, voir ACCEPTANCE.md)
- Échec LLM (réponse invalide, timeout provider) → message "Une erreur est survenue pendant l'analyse de votre texte" + retour à l'écran Nouvelle génération avec le texte préservé, crédit non décompté
- Échec de rendu Puppeteer (template cassé, contenu généré incompatible) → même traitement, message adapté "Une erreur est survenue pendant la mise en page"
- Utilisateur quitte la page pendant le traitement → la génération continue côté serveur, visible comme "En cours" puis mise à jour au retour sur le Dashboard

---

### Écran 5 — Résultat

**Objectif** : livrer la valeur — prévisualiser et télécharger.
**Utilisateur** : génération terminée avec succès.

**Workflow**
1. Prévisualisation de toutes les slides (carrousel navigable, flèches ou swipe)
2. Deux boutons de téléchargement clairs : **"Télécharger les images (ZIP)"** et **"Télécharger le PDF"**
3. Lien retour vers le Dashboard

**États**
- *Chargement des assets* : si les fichiers ne sont pas encore disponibles en storage au moment de l'affichage (race condition rendu → storage), état "Préparation des fichiers…" avant activation des boutons
- *Erreur de téléchargement* : lien expiré ou fichier introuvable en storage → message + bouton "Régénérer le lien"

**Edge cases**
- Résultat avec un nombre de slides inhabituel (très peu ou beaucoup, selon les bornes définies dans PROMPTS.md) → l'aperçu doit rester utilisable quel que soit le nombre (pas de limite d'affichage dans le carrousel de preview)
- Utilisateur revient sur un résultat ancien depuis l'historique → mêmes boutons de téléchargement, mêmes règles de lien

---

### Écran 6 — Achat de crédits

**Objectif** : convertir un utilisateur à 0 crédit.
**Utilisateur** : crédits épuisés.

**Workflow**
1. Une seule offre affichée en MVP (un seul pack de crédits) — pas de grille de plans à comparer
   - *Justification* : tester la conversion sur une offre unique avant d'investir dans une grille tarifaire multi-plans (P1)
2. CTA "Acheter" → redirection Stripe Checkout (hébergé par Stripe, pas de formulaire de carte custom)
3. Retour sur Slideify après paiement → crédits déjà crédités (via webhook, pas de polling nécessaire côté client si le webhook est traité avant la redirection ; sinon état transitoire "Confirmation en cours…")

**États**
- *Chargement* : redirection vers Stripe → spinner bref pendant la création de la session Checkout
- *Erreur* : échec de création de session Checkout → message + bouton "Réessayer"
- *Retour après annulation* (utilisateur quitte Stripe sans payer) → retour à l'écran Achat, aucun message d'erreur (annulation normale, pas un échec)

**Edge cases**
- Webhook Stripe reçu en retard (paiement confirmé mais crédits pas encore visibles au retour utilisateur) → état "Confirmation de paiement en cours…" avec rafraîchissement automatique du compteur de crédits (polling court, quelques secondes)
- Paiement dupliqué (double clic) → géré côté Stripe Checkout nativement (session unique par clic), pas de logique custom nécessaire

---

## Ce qui n'existe pas en MVP (et pourquoi)

- **Pas d'écran de paramètres/profil** : rien à configurer (pas de branding, pas de préférences) tant que ces features ne sont pas P0
- **Pas de choix de template au moment de la génération** : un seul template = pas d'écran de sélection
- **Pas d'édition post-génération** : le résultat est final ; si insatisfaisant, l'utilisateur relance une génération (avec un texte ajusté) plutôt que d'éditer — évite de construire un éditeur de slides complet en MVP
