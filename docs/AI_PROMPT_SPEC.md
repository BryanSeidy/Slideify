# AI_PROMPT_SPEC.md

## Statut de ce document

Spécification exacte de la couche IA. Supersede et détaille `docs/PROMPTS.md` (V1) — les règles ci-dessous font foi en cas de divergence. Rien dans le worker ne doit contenir de prompt ou de règle de validation qui ne soit pas défini ici.

---

## 1. Interface `LLMProvider`

Contrat unique, implémenté par deux classes : `MockProvider` (dev/test, **par défaut partout sauf production**) et `OpenRouterProvider` (production uniquement, activé par variable d'environnement).

```
interface LLMProvider {
  generateSlides(sourceText: string): Promise<LLMResponse>
}

type LLMResponse = {
  slides: Array<{ order: number, title: string, body: string }>,
  meta: { slide_count: number, source_language: string }
}
```

Le worker (`GENERATION_SPEC.md` étape 2-3) n'appelle **jamais** OpenRouter ou un `MockProvider` directement — toujours via cette interface, résolue par injection de dépendance selon la variable d'environnement `AI_PROVIDER` (`mock` | `openrouter`). **Valeur par défaut de `AI_PROVIDER` en développement : `mock`.** Ne jamais coder `openrouter` en dur, y compris temporairement pour tester — la bascule doit toujours passer par la variable d'environnement.

---

## 2. Prompt système (fixe, utilisé uniquement par `OpenRouterProvider`)

```
Tu es un assistant spécialisé dans la structuration de contenu pour carrousels
professionnels destinés à LinkedIn et Instagram.

À partir d'un texte source, tu dois produire une séquence de slides qui :
- capture les idées clés du texte, dans un ordre logique et progressif
- commence par une slide d'accroche (hook) qui donne envie de swiper
- termine par une slide de conclusion ou d'appel à l'action clair
- utilise un langage direct, concis, sans jargon inutile
- ne recopie jamais le texte source mot pour mot : reformule et condense

Contraintes strictes de format :
- Titre de slide : 60 caractères maximum
- Corps de slide : 220 caractères maximum
- Nombre de slides : entre 5 et 10
- Réponds UNIQUEMENT avec un objet JSON valide respectant exactement ce schéma,
  sans aucun texte, explication ou balise markdown autour :

{
  "slides": [{"order": number, "title": string, "body": string}],
  "meta": {"slide_count": number, "source_language": string}
}
```

## 3. Prompt utilisateur (template, utilisé uniquement par `OpenRouterProvider`)

```
Texte source :
"""
{{sourceText}}
"""

Structure ce texte en carrousel selon les règles du système.
```

Pas de variable additionnelle en P0 (pas de ton, pas de public cible imposé — tout est déduit automatiquement par le modèle).

---

## 4. `MockProvider` — spécification exacte

**But** : reproduire une variabilité réaliste (nombre de slides, longueurs) sans aucun appel réseau, pour que le pipeline de rendu soit testé dans des conditions représentatives, à coût et latence nuls.

### Algorithme

1. Découper `sourceText` en phrases (séparateurs `. ! ?`)
2. Regrouper les phrases en un nombre de slides `N`, où `N = clamp(round(nombre_de_phrases / 3), 5, 10)` (au moins 5, au plus 10, quel que soit le texte d'entrée — un texte très court génère quand même 5 slides en répartissant/répétant le contenu disponible, un texte très long est condensé)
3. Pour chaque groupe de phrases : générer un `title` (les 5 premiers mots du premier segment du groupe, tronqués à 60 caractères) et un `body` (concaténation du groupe, tronquée à 220 caractères avec troncature au dernier mot complet + ellipse si dépassement)
4. `meta.source_language` : détection naïve (si le texte contient une majorité de mots-outils français fréquents → `"fr"`, sinon `"en"` par défaut) — suffisant pour un mock, pas besoin d'une vraie librairie de détection de langue
5. **Latence simulée** : introduire un délai artificiel aléatoire entre 2 et 8 secondes avant de résoudre la promesse, pour que l'UX de chargement (`UX_FLOW.md`) soit testée dans des conditions temporelles réalistes plutôt qu'instantanées

### Mode d'échec simulé (pour tester les chemins d'erreur sans dépendre d'un vrai provider capricieux)

Le `MockProvider` doit accepter un texte source contenant un marqueur spécial pour déclencher volontairement chaque type d'échec en test :
- Texte contenant `__MOCK_TIMEOUT__` → ne résout jamais (simule `ERR_AI_TIMEOUT`)
- Texte contenant `__MOCK_INVALID_JSON__` → retourne une chaîne non-JSON
- Texte contenant `__MOCK_SCHEMA_INVALID__` → retourne un JSON valide mais avec `slide_count = 3` (hors bornes)

Ces marqueurs ne doivent **jamais** être documentés ou exposés dans l'UI — usage interne aux tests d'intégration uniquement.

---

## 5. Validation de la réponse (identique quel que soit le provider)

Ordre des contrôles, appliqué par le worker après réception de la réponse (`LLMResponse` ou échec du provider) :

1. **Parsing JSON** (uniquement pertinent pour `OpenRouterProvider`, le `MockProvider` retourne déjà un objet typé sauf en mode `__MOCK_INVALID_JSON__`)
   - Échec → un seul retry avec le prompt de correction ci-dessous
   - Second échec → `FAILED`, `ERR_AI_INVALID_RESPONSE`
2. **Présence du schéma** : `slides` (array non vide) et `meta` présents
3. **Bornes** :
   - `slides.length` entre 5 et 10 → sinon `FAILED`, `ERR_AI_SCHEMA_INVALID`
   - chaque `title` ≤ 60 caractères → si dépassement mineur, troncature automatique (dernier mot complet + ellipse), pas d'échec
   - chaque `body` ≤ 220 caractères → même règle de troncature automatique
4. **Cohérence des `order`** : séquence continue de 1 à N, sans doublon ni trou → sinon `FAILED`, `ERR_AI_SCHEMA_INVALID`

### Prompt de correction (retry, une seule tentative, `OpenRouterProvider` uniquement)

```
Ta réponse précédente n'était pas un JSON valide. Réponds à nouveau,
UNIQUEMENT avec l'objet JSON demandé, sans aucun texte autour.
```

---

## 6. `OpenRouterProvider` — notes de production (non implémenté en développement)

- Modèle exact et paramètres (`temperature`, `max_tokens`) : à décider **au moment de l'activation production**, pas en développement — ne pas bloquer le développement sur ce choix
- Doit respecter strictement la même interface `LLMResponse` que le `MockProvider` — aucun code du worker ne doit changer entre les deux providers
- Clé API (`OPENROUTER_API_KEY`) injectée uniquement en environnement de production, jamais committée, jamais utilisée en développement même à titre de test ponctuel (contrainte budget 0€, cf. `docs/DECISIONS.md` ADR-008)

---

## 7. Versioning des prompts

Le prompt système est versionné implicitement par le code (pas de système de versioning de prompt externe en P0 — complexité non justifiée au volume MVP). Toute modification du prompt système doit être accompagnée d'une entrée dans `docs/DECISIONS.md` si elle change les bornes ou le schéma de sortie (impact direct sur `Slide` et le template de rendu).
