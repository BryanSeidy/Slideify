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