# AGENTS.md

## Guide pour les futurs agents

### Règles générales

1. **Lire les docs avant toute modification** — Vérifier PRODUCT.md, ARCHITECTURE.md, DECISIONS.md avant de commencer
2. **Ne pas élargir le scope** — Ne pas ajouter de fonctionnalités hors du périmètre défini
3. **Ne jamais inventer de fonctionnalités** — Tout doit être documenté et justifié
4. **Ne jamais hardcoder de secrets** — Utiliser uniquement les variables d'environnement (.env)
5. **Respecter TypeScript strict** — Activer strictMode, pas de `any` non justifié
6. **Tester les changements** — Ajouter ou modifier des tests pour toute nouvelle fonctionnalité
7. **Documenter les décisions importantes** — Mettre à jour DECISIONS.md si une décision architecturale change
8. **Ne pas modifier les zones d'un autre agent sans raison** — Respecter les boundaries définis
9. **Signaler les problèmes plutôt que les cacher** — Ouvrir des issues si bloqué ou incertain

### Rôles d'agents

#### Claude1
- Product / UX / specifications
- Définir le "quoi" et le "pourquoi"
- Rédiger les spécifications fonctionnelles

#### OpenCode
- Implementation
- Écrire le code, les tests, la configuration
- S'assurer que ça compile et fonctionne

#### Claude2
- QA / Security / Growth review
- Vérifier la qualité, la sécurité
- S'assurer que les guidelines sont respectées

#### ClaudeCode
- Senior engineering / integration / release
- Intégration continue, déploiement
- Refactoring et optimisation à plus long terme

### Workflow typique

1. Agent lit la documentation en cours (PRODUCT.md, ARCHITECTURE.md)
2. Agent crée une branche feature/fix correspondant
3. Agent implémente la changement
4. Agent ajoute/modifie les tests
5. Agent met à jour la documentation si nécessaire
6. Agent ouvre une PR en direction de `develop`
7. Revue et validation avant merge

### Lint & Typecheck

- `bun run lint` ou `npm run lint` — Vérifier le style
- `bun run typecheck` ou `npm run typecheck` — Vérifier TypeScript
- Ne jamais commiter en cas d'erreurs lint/typecheck

### Nouveau agent : première étape

1. Cloner le repository
2. Lire AGENTS.md, DECISIONS.md, ARCHITECTURE.md
3. Vérifier .env.example et configurer .env local
4. Lancer `bun install` (ou npm/pnpm)
5. Lancer `bun run dev` pour vérifier que le projet démarre