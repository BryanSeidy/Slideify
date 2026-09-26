# CONTRIBUTING.md

## Guidelines for contributors

### Branch naming

- `main` — Production stable uniquement
- `develop` — Version en développement (cible principale des PR)
- `feature/<nom>` — Nouvelles fonctionnalités
- `fix/<nom>` — Correctifs de bugs
- `refactor/<nom>` — Refactoring
- `docs/<nom>` — Documentation seulement
- `chore/<nom>` — Tâches de maintenance

### Commit naming

Convention de commits (Conventional Commits) :

```
type: description courte en anglais
```

Types autorisés :

- `feat:` — Nouvelle fonctionnalité
- `fix:` — Correction de bug
- `docs:` — Modification de documentation
- `refactor:` — Refactoring de code (pas de changement de comportement)
- `test:` — Ajout ou modification de tests
- `chore:` — Tâches de maintenance (config, dependencies, etc.)
- `ci:` — Configuration CI/CD
- `style:` — Formatage, indentation (non fonctionnel)

Exemples :

```
feat: add generation queue
fix: handle failed generation
docs: update architecture
chore: configure eslint
test: add unit tests for worker
```

### Pull request expectations

1. **Titre clair** — Résumer le changement dans le titre
2. **Description détaillée** — Expliquer quoi, pourquoi, comment
3. **Lien avec les tâches** — Mentionner la TASK-xxx concernée
4. **Capture d'écran / demo** — Si applicable (nouvelle UI, output)
5. **Tests** — Prouver que les tests passent
6. **Lint & Typecheck** — Prouver qu'il n'y a pas d'erreurs

### Testing

- Ajouter des tests pour toute nouvelle fonctionnalité
- Ne pas casser les tests existants
- Lancer `bun test` (ou `npm test`) avant de pousser

### Documentation

- Mettre à jour la documentation correspondante si le comportement change
- Ajouter des notes dans DECISIONS.md pour les décisions architecturale importantes
- Garder PRODUCT.md à jour avec les nouvelles fonctionnalités

### Code review

- Toute PR doit être revue avant merge
- Vérifier la conformité TypeScript strict
- S'assurer que les conventions de commit sont respectées
- Vérifier qu'il n'y a pas de secrets hardcodés

### License

Ce projet est sous licence [non définie]. Voir DECISIONS.md pour le statut actuel.