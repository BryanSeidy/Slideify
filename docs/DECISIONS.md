# DECISIONS.md

## Journal des décisions architecturales (ADR)

### ADR-001
**TypeScript-first architecture**

- **Context** : Choix du langage pour tout le projet (frontend + backend)
- **Decision** : TypeScript strict à tous les niveaux
- **Reason** : Détecter les erreurs à la compilation, meilleure maintenabilité, échelle future
- **Consequences** : Courbe d'apprentissage initiale, mais sécurité accrue

### ADR-002
**Next.js frontend**

- **Context** : Framework React pour l'interface utilisateur
- **Decision** : Next.js 14 avec App Router
- **Reason** : Rendement, SEO, routing intégré, edge capabilities
- **Consequences** : VerrouillageNext.js, mais écosystème solide

### ADR-003
**NestJS backend**

- **Context** : Framework Node.js pour l'API
- **Decision** : NestJS avec pattern modular
- **Reason** : Structure opinionnée, DI container, robustesse, scaling
- **Consequences** : Convention sur la place des fichiers, learning curve

### ADR-004
**PostgreSQL + Prisma**

- **Context** : Base de données relationnelle pour les données utilisateur, génération, etc.
- **Decision** : PostgreSQL avec Prisma ORM
- **Reason** : Standard industriel, relations complexes supportées, migrations typescriptées
- **Consequences** : Migration au format SQL, dépendance Prisma

### ADR-005
**BullMQ + Redis pour traitement asynchrone**

- **Context** : Gestion de la file d'attente de génération de contenu
- **Decision** : BullMQ (client Redis) pour les workers
- **Reason** : Feature-rich, TypeScript-first, robuste pour les tâches lourdes
- **Consequences** : Dépendance Redis, architecture worker séparée

### ADR-006
**HTML/CSS + Puppeteer pour rendering**

- **Context** : Rendu de PDFs et images à partir de contenu structuré
- **Decision** : HTML/CSS templates + Puppeteer headless Chrome
- **Reason** : Contrôle total du layout, sortie PDF/PNG de qualité, pas de dépendance externe
- **Consequences** : Dépendance Chromium, CPU intensive pendant le rendu

### ADR-007
**LLM provider abstraction**

- **Context** : Interface vers les providers d'IA (OpenRouter, etc.)
- **Decision** : Interface abstraite avec implémentation mock pour le développement
- **Reason** : Remplacer facilement de provider, développer sans consommer de quotas
- **Consequences** : Couche d'abstraction à maintenir, mocks à jour

### ADR-008
**Zero-budget development strategy**

- **Context** : Pas de budget pour services payants pendant le développement
- **Decision** : Tout développer localement, mockers services externes, brancher payants seulement en production
- **Reason** : Éviter de brûler des quotas gratuits, coûts maîtrisés, prototype avant d'investir
- **Consequences ** : Services mocks en dev, migration vers réels plus tard

### ADR-009
**Monorepo with Turborepo/Bun**

- **Context** : Structure unifiée pour web, api, worker
- **Decision** : Structure monorepo avec package.json racine + packages/
- **Reason** : Partage de types, installation unique, husky/lint cohérent
- **Consequences ** : Configuration initiale, cache workspace

### ADR-010
**Abstraction PaymentProvider (paiement)**

- **Context** : Les spécifications V1/V2 supposaient Stripe Checkout. Stripe n'ouvre des comptes marchands que dans une liste limitée de pays ; le Cameroun n'apparaît pas dans les sources consultées (il n'y figure que pour Stripe Tax). À confirmer par l'owner sur la page officielle de disponibilité de Stripe. Le choix d'un fournisseur dépend de l'entité qui encaisse, de l'audience et du prix, qui sont des décisions de l'owner. Budget 0 € en développement (ADR-008) : aucun paiement réel avant la production.
- **Decision** : Une interface `PaymentProvider` (création d'un paiement hébergé, vérification d'une transaction, lecture d'un événement de paiement), sur le modèle de `LLMProvider` (ADR-007). Sélection par `PAYMENT_PROVIDER` : `mock` (défaut hors production) ou le fournisseur retenu. Un seul fournisseur actif au lancement. Checkout hébergé par le fournisseur. Une commande est enregistrée avant la redirection. Les crédits ne sont ajoutés qu'après **vérification serveur** de la transaction, sous forme d'une ligne de ledger `PURCHASE` dont la référence est l'identifiant de transaction (unicité globale, idempotence). Le montant crédité vient de la configuration du pack. Démarrage refusé en production sans configuration réelle, sans repli vers le mock.
- **Reason** : Le reste du produit (ledger, écrans, événements) ne dépend pas du fournisseur ; changer de fournisseur ou ajouter Stripe plus tard se limite à un adaptateur. Le mock permet de tester succès, annulation, échec et confirmation retardée sans argent réel.
- **Consequences** : Choix du fournisseur et ouverture du compte marchand à la charge de l'owner (O-1, délai de vérification possible de plusieurs jours). Ajout du type de ledger `PURCHASE` (migration additive, jalon M010). Table de commandes et table d'événements de paiement à prévoir. Les variables `PAYMENT_*` de `.env.example` restent génériques. Statut : interface acceptée ; fournisseur à trancher.

### ADR-011
**Authentification par email et mot de passe (JWT)**

- **Context** : Les spécifications V1/V2 prévoyaient un magic link (Supabase Auth). Le red team M004.2 a démontré qu'une route de connexion par email seul permettait de prendre le contrôle de n'importe quel compte. M004.3 a supprimé les magic links et adopté email + mot de passe.
- **Decision** : `POST /auth/register` (201, sans jeton) et `POST /auth/login` (JWT HS256 après `bcrypt.compare`). Les 3 crédits gratuits sont écrits dans la **même transaction que la création du compte** (`MANUAL_GRANT`, référence `signup_bonus`). **Aucune route ne délivre un JWT sur la seule base d'un email.** Email normalisé (espaces retirés, minuscules) avant unicité. `AUTH_SECRET` de 32 caractères minimum. Mot de passe de 8 à 72 octets.
- **Reason** : Aucun fournisseur d'envoi d'email n'est disponible à budget 0 €. La connexion par email seul est une faille critique. Les crédits gratuits atomiques avec la création du compte évitent un second chemin d'attribution.
- **Consequences** : Supabase Auth n'est plus utilisé pour l'authentification (Supabase peut rester l'hébergeur PostgreSQL et du stockage). **Pas de vérification d'email ni de récupération de mot de passe** au lancement doux (réinitialisation manuelle) ; décision O-6 avant l'ouverture publique, avec le coût décrit dans `M006` §4.4. Limitation de débit sur `/auth/*`, bcrypt à 12 et JWT de 24 h avec refresh requis avant l'ouverture publique (porte E). Le farming de crédits par comptes multiples reste possible tant que la vérification d'email n'existe pas.
