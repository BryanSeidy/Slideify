# AI Contract — Slideify MVP

## Interface Target

### LLMProvider Interface

```typescript
export interface LLMProvider {
  generate(sourceText: string): Promise<LLMResponse>;
}
```

### Contract Obligations

| Direction | Contract |
|-----------|----------|
| Provider → App | JSON object exactly matching `LLMResponseSchema` |
| App → Provider | Source text (string), system prompt fixe |
| App → Provider | Aucun autre paramètre (pas de ton, public cible, langue forcée) |

### Sortie JSON Obligatoire (Non négociable)

```json
{
  "slides": [
    {"order": number, "title": string, "body": string}
  ],
  "meta": {"slide_count": number, "source_language": string}
}
```

**Règles** :
1. **Uniquement du JSON** — Aucun texte avant/après, aucun bloc markdown
2. **slides.length** : 5 à 10 inclus
3. **title** : ≤ 60 caractères
4. **body** : ≤ 220 caractères
5. **order** : 1..N sans doublon, continu

### Validation Côté Worker (Pipeline)

Ordre des contrôles, chaque échec est terminal :

1. **Parsing JSON** — Si échec, retry une seule fois avec prompt de correction
   - Prompt de correction : `"Ta réponse précédente n'était pas un JSON valide. Réponds à nouveau, UNIQUEMENT avec l'objet JSON demandé, sans aucun texte autour."`
   - Après 2ème échec → génération marquée en erreur, **aucun crédit décompté**

2. **Schéma** — Présence de `slides` (array non vide) et `meta`
   - Si absent → retry + prompt de correction, puis échec terminal

3. **Bornes** — `slide_count` entre 5 et 10 ; chaque `title` ≤ 60 char ; chaque `body` ≤ 220 char
   - **Tolérance** : Dépassement mineur (ex. body = 235) → tronçonnage propre (dernier mot complet + ellipse)
   - Juste au-delà (11 slides ou 61 chars title) → échec, marqué en erreur

4. **Cohérence des order** — Séquence continue de 1 à N sans doublon
   - Si doublon ou saut → échec, marqué en erreur

### Provider Errors

| Erreur | Description | Comportement |
|--------|-------------|--------------|
| `LLM_ERROR` | Provider unreachable, timeout, quota épuisé | Marquer FAILED, crédit non décompté |
| `INVALID_RESPONSE` | JSON non valide après retry | Marquer FAILED, crédit non décompté |
| `MALFORMED_OUTPUT` | Schéma non conforme après validation | Marquer FAILED, crédit non décompté |
| `TIMEOUT` | Provider > 90s sans réponse | Marquer FAILED, crédit non décompté |

### Metadata (Non source de vérité)

Le champ `meta.source_language` est **informatif seulement** :
- Détecté automatiquement par MockProvider (accents français = fr)
- Pas utilisé pour la validation
- Utilisable pour analytics futurs

### MockProvider Contract

```typescript
class MockProvider implements LLMProvider {
  async generate(sourceText: string): Promise<LLMResponse>
}
```

**Engagements MockProvider** :
- Retourne toujours un `LLMResponse` valide
- 5 ≤ slides.length ≤ 10
- title ≤ 60 char, body ≤ 220 char
- ordres 1..N sans doublon
- source_language détecté depuis texte (fr si accents, sinon en)
- Génère des slides variables (pas JSON statique)

### OpenRouterProvider Contract

```typescript
class OpenRouterProvider implements LLMProvider {
  constructor(apiKey: string, model: string, siteUrl?: string, siteName?: string)
  async generate(sourceText: string): Promise<LLMResponse>
}
```

**Engagements** :
- Appel HTTPS POST vers https://openrouter.ai/api/v1/chat/completions
- Headers requis : Authorization, Content-Type, HTTP-Referer, X-Title
- Format messages [system, user] exactement tel que défini
- response_format { type: 'json_object' }
- Temperature: 0.3
- Max tokens: 2000

### Fallback Policy

1. MockProvider utilisé automatiquement quand OPENROUTER_API_KEY non définie
2. Si OpenRouter error → passer à MockProvider pour les cas de test/dev
3. Jamais fall-back automatique en production sans notification

## Schéma Zod (Single Source of Truth)

```typescript
export const SlideSchema = z.object({
  order: z.number().int().min(1).max(10),
  title: z.string().min(1).max(60),
  body: z.string().min(1).max(220),
});

export const LLMResponseSchema = z.object({
  slides: z.array(SlideSchema).min(5).max(10),
  meta: z.object({
    slide_count: z.number().int(),
    source_language: z.string().min(2).max(2),
  }),
});

export const GenerationInputSchema = z.object({
  sourceText: z.string().min(80, 'Texte trop court').max(3000, 'Texte trop long'),
});
```

---

## Validation Pipeline (Diagramme)

```
Source Text
     ↓
LLMProvider.generate()
     ↓
JSON.parse() attempt 1
     │
     ├─── Success ───→ Validate schema (Zod)
     │                  │
     │                  ├─── Valid → Render slides
     │                  │           │
     │                  │           └─── Success → Store outputs + consume credit
     │                  │                       │
     │                  │                       └─── Failure → FAILED + no credit
     │                  │
     │                  └─── Invalid → Validation error → FAILED + no credit
     │
     └─── Failure ───→ JSON.parse() attempt 2 (retry)
                          │
                          ├─── Success ───→ Validate schema (Zod)
                          │
                          └─── Failure (2nd fail) → FAILED + no credit
```

---

## Exemples de Réponses Conformes

### ✅ Exemple 1 (5 slides)

```json
{
  "slides": [
    {"order": 1, "title": "Introduction", "body": "Contenu de la slide 1"},
    {"order": 2, "title": "Point clé", "body": "Contenu de la slide 2"},
    {"order": 3, "title": "Développement", "body": "Contenu de la slide 3"},
    {"order": 4, "title": "Exemple", "body": "Contenu de la slide 4"},
    {"order": 5, "title": "Conclusion", "body": "Contenu de la slide 5"}
  ],
  "meta": {"slide_count": 5, "source_language": "en"}
}
```

### ✅ Exemple 2 (7 slides, body tronqué)

```json
{
  "slides": [
    {"order": 1, "title": "Très long titre qui dépasse", body: "Texte qui dépasse 220 caractères et qui est tronqué proprement..."},
    ...
  ],
  "meta": {"slide_count": 7, "source_language": "fr"}
}
```

### ❌ Exemple 3 (Non conforme — 3 slides)

```json
{
  "slides": [...],  // 3 slides seulement → échec validation
  "meta": {"slide_count": 3, "source_language": "en"}
}
```

### ❌ Exemple 4 (Non conforme — body > 220 chars non tronqué)

```json
{
  "slides": [...],  // body dépasse 220 chars sans ellipse → échec validation
  "meta": {"slide_count": 5, "source_language": "en"}
}
```