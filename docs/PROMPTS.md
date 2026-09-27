# PROMPTS.md

## Rôle de ce document

Spécification exacte de l'interaction avec le LLM (via `OpenRouter`, interface `LLMProvider`, cf. ADR-007). Le worker ne doit contenir **aucune logique métier de prompt inline** — tout part d'ici. En développement, le `MockProvider` doit retourner une réponse respectant strictement le même schéma JSON que le provider réel.

---

## Contrat de sortie (schéma unique, non négociable)

Le LLM doit retourner **uniquement du JSON**, aucun texte avant/après, aucun bloc markdown. Schéma :

```json
{
  "slides": [
    { "order": 1, "title": "string, max 60 caractères", "body": "string, max 220 caractères" }
  ],
  "meta": {
    "slide_count": "number, doit égaler slides.length",
    "source_language": "code langue ISO 639-1 détecté (ex: 'fr', 'en')"
  }
}
```

**Bornes imposées** (rejetées côté worker si non respectées, indépendamment de ce que répond le LLM) :
- `slides.length` entre **5 et 10** inclus
- `title` : 60 caractères max
- `body` : 220 caractères max (le template visuel est conçu pour cette limite — un dépassement casse la mise en page)

*Justification des bornes* : un carrousel < 5 slides ne justifie pas le format ; > 10 slides dépasse l'attention moyenne sur un carrousel social. Ces bornes protègent aussi le rendu Puppeteer d'un contenu imprévisible.

---

## Prompt système (fixe)

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

## Prompt utilisateur (template)

```
Texte source :
"""
{{TEXTE_UTILISATEUR}}
"""

Structure ce texte en carrousel selon les règles du système.
```

*Pas de variables additionnelles en P0* (pas de ton, pas de public cible, pas de langue forcée — tout est déduit automatiquement). Ces paramètres sont un P1 (personnalisation).

---

## Validation côté worker (après réponse LLM)

Ordre des contrôles, chaque échec est terminal (pas de correction automatique silencieuse en MVP — mieux vaut échouer proprement que produire un résultat dégradé) :

1. **Parsing JSON** — si échec, retry une fois avec un prompt de correction (voir ci-dessous), puis échec terminal
2. **Schéma** — présence de `slides` (array non vide) et `meta`
3. **Bornes** — `slide_count` entre 5 et 10 ; chaque `title` ≤ 60 car. ; chaque `body` ≤ 220 car.
4. **Cohérence des `order`** — séquence continue de 1 à N sans doublon

Si une réponse dépasse légèrement une borne de longueur (ex. `body` à 235 caractères), le worker **tronque proprement** (jusqu'au dernier mot complet, avec ellipse) plutôt que d'échouer — seule tolérance automatique admise, car un dépassement mineur de longueur ne dégrade pas le sens.

### Prompt de correction (retry, une seule tentative)

Utilisé uniquement si le parsing JSON échoue au premier essai :

```
Ta réponse précédente n'était pas un JSON valide. Réponds à nouveau,
UNIQUEMENT avec l'objet JSON demandé, sans aucun texte autour.
```

Après un deuxième échec → la génération est marquée en erreur (voir UX.md, écran 4), le crédit n'est pas décompté.

---

## MockProvider (développement, ADR-007)

Le mock ne doit **pas** retourner un JSON statique unique — il doit générer un nombre de slides variable (aléatoire entre 5 et 10) à partir du texte d'entrée réel (ex. découpage naïf en phrases), pour que le rendu Puppeteer soit testé contre une variabilité réaliste sans consommer de quota OpenRouter.

---

## Hors périmètre MVP (rappel)

- Génération de légendes/hashtags (P1) → prompt séparé, à spécifier au moment de l'implémentation P1
- Choix de ton/style par l'utilisateur (P1)
- Détection et gestion multi-langue avancée au-delà du champ `source_language` informatif (P2)
