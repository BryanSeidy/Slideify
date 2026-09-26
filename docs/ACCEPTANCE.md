# ACCEPTANCE.md

## Rôle de ce document

Critères d'acceptation par feature P0, format Given/When/Then. Une feature n'est **livrable** que si tous ses critères sont vérifiés, y compris les cas d'erreur — un happy path qui marche seul ne suffit pas.

---

## Feature : Authentification (magic link)

- **Given** un utilisateur non connecté sur l'écran Auth, **When** il saisit un email valide et clique "Envoyer le lien", **Then** un email contenant un lien à usage unique est envoyé et un message de confirmation s'affiche
- **Given** un email invalide saisi, **When** l'utilisateur clique "Envoyer", **Then** l'envoi est bloqué côté front avec un message d'erreur inline, aucune requête n'est faite au backend
- **Given** un lien magic link valide cliqué, **When** la redirection s'effectue, **Then** l'utilisateur est connecté et redirigé vers le Dashboard, une session est créée
- **Given** un lien magic link expiré (>1h) cliqué, **When** la redirection s'effectue, **Then** une page dédiée explique l'expiration avec un CTA pour redemander un lien
- **Given** un lien déjà utilisé cliqué une seconde fois, **When** la redirection s'effectue, **Then** l'accès est refusé avec le même message que "lien expiré" (pas de distinction technique exposée à l'utilisateur)

## Feature : Saisie et lancement d'une génération

- **Given** un utilisateur avec ≥1 crédit sur l'écran Nouvelle génération, **When** il colle un texte dans la fourchette valide (bornes définies dans PROMPTS.md) et clique "Générer", **Then** un job est créé dans la queue BullMQ, l'utilisateur est redirigé vers l'écran Génération en cours, **aucun crédit n'est décompté à cette étape**
- **Given** un texte inférieur à la borne minimale, **When** l'utilisateur tente de générer, **Then** le bouton est désactivé et un message explicite indique le nombre de mots manquants
- **Given** un texte supérieur à la borne maximale, **When** l'utilisateur tente de générer, **Then** le bouton est désactivé et un message invite à raccourcir le texte
- **Given** un utilisateur avec 0 crédit, **When** il arrive sur l'écran Nouvelle génération, **Then** le bouton "Générer" est remplacé par un CTA "Acheter des crédits", la saisie de texte reste possible et n'est pas perdue au clic

## Feature : Génération (pipeline LLM + rendu)

- **Given** un job en file d'attente, **When** le worker le prend en charge, **Then** le statut visible côté client passe de "Préparation…" à "Analyse du contenu…"
- **Given** une réponse LLM valide (JSON conforme au schéma, bornes respectées), **When** le rendu Puppeteer s'exécute, **Then** un fichier PNG par slide et un PDF assemblé sont produits et stockés, le statut passe à "Terminé", **le crédit est décompté à ce moment précis**
- **Given** une réponse LLM non-JSON au premier essai, **When** le worker retente une fois avec le prompt de correction, **Then** si le second essai échoue également, la génération est marquée en erreur et **aucun crédit n'est décompté**
- **Given** une réponse LLM JSON valide mais hors bornes (ex. 3 slides ou 14 slides), **When** le worker valide le schéma, **Then** la génération est rejetée et marquée en erreur, aucun crédit décompté
- **Given** un `body` de slide dépassant légèrement 220 caractères (ex. 235), **When** le worker post-traite la réponse, **Then** le texte est tronqué proprement au dernier mot complet avec ellipse, la génération continue normalement
- **Given** un job dépassant le seuil de timeout (90s), **When** le worker détecte le dépassement, **Then** le job est marqué en échec, l'utilisateur voit un message de timeout explicite, aucun crédit décompté
- **Given** un échec de rendu Puppeteer (template incompatible avec le contenu généré), **When** l'erreur survient, **Then** la génération est marquée en erreur avec un message distinct de l'erreur LLM, aucun crédit décompté

## Feature : Résultat et téléchargement

- **Given** une génération terminée avec succès, **When** l'utilisateur arrive sur l'écran Résultat, **Then** toutes les slides sont prévisualisables dans un carrousel navigable, dans l'ordre `order` défini par le LLM
- **Given** l'écran Résultat affiché, **When** l'utilisateur clique "Télécharger les images (ZIP)", **Then** un fichier ZIP contenant un PNG par slide, numéroté selon l'ordre, est téléchargé
- **Given** l'écran Résultat affiché, **When** l'utilisateur clique "Télécharger le PDF", **Then** un PDF contenant l'ensemble des slides dans l'ordre est téléchargé
- **Given** un lien de fichier expiré en storage, **When** l'utilisateur tente un téléchargement, **Then** un message d'erreur s'affiche avec une option pour régénérer le lien (pas de lien mort silencieux)

## Feature : Historique (Dashboard)

- **Given** un utilisateur avec au moins une génération passée, **When** il arrive sur le Dashboard, **Then** la liste affiche chaque génération avec vignette (première slide), date, et statut
- **Given** une génération en cours au moment du chargement du Dashboard, **When** la liste s'affiche, **Then** la carte correspondante indique "En cours" sans vignette ni action de clic disponible
- **Given** une génération échouée, **When** l'utilisateur clique sur sa carte, **Then** le détail de l'erreur s'affiche, sans option de "relancer automatiquement" (l'utilisateur doit repasser par Nouvelle génération)
- **Given** un utilisateur sans aucune génération, **When** il arrive sur le Dashboard, **Then** un état vide avec message d'accroche et CTA "Créer mon premier carrousel" s'affiche (pas de tableau vide silencieux)

## Feature : Crédits et paiement

- **Given** un nouvel utilisateur, **When** son compte est créé, **Then** 3 crédits gratuits sont attribués automatiquement, sans action manuelle
- **Given** un utilisateur à 0 crédit sur l'écran Achat, **When** il clique "Acheter", **Then** une session Stripe Checkout est créée et l'utilisateur y est redirigé
- **Given** un paiement Stripe confirmé (webhook `checkout.session.completed` reçu), **When** le webhook est traité, **Then** les crédits du pack sont ajoutés au compte de l'utilisateur, de façon idempotente (un même événement webhook reçu deux fois ne crédite qu'une fois)
- **Given** un utilisateur annulant son paiement sur Stripe, **When** il revient sur Slideify, **Then** il est renvoyé à l'écran Achat sans message d'erreur (annulation ≠ échec)
- **Given** un webhook reçu avec un délai après le retour utilisateur, **When** l'utilisateur est déjà revenu sur Slideify, **Then** le compteur de crédits se met à jour automatiquement dès réception du webhook (rafraîchissement court, sans action manuelle de l'utilisateur)

---

## Critères transverses (toutes features)

- Aucune action ne doit laisser l'utilisateur sans feedback pendant plus de 500ms sans indicateur de chargement
- Aucun crédit n'est jamais décompté avant la confirmation de succès complet d'une génération (LLM + rendu + stockage)
- Tout message d'erreur visible par l'utilisateur est en français, non technique (pas de stack trace, pas de code d'erreur brut)
