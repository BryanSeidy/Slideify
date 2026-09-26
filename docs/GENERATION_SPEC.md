# GENERATION_SPEC.md

## Statut de ce document

Spécification d'exécution du pipeline de génération. Destiné à être implémenté tel quel — les noms de champs, types, et transitions d'état ci-dessous sont les noms à utiliser dans le code (migrations Prisma, DTOs NestJS), pas des exemples illustratifs.

---

## 1. Machine à états de la génération

### États (`Generation.status`)

```
QUEUED → PROCESSING_AI → RENDERING → COMPLETED
                  ↓             ↓
                FAILED       FAILED
```

- Aucune transition inverse. Aucun état "annulé par l'utilisateur" en P0 (pas de bouton d'annulation dans `UX_FLOW.md`).
- `FAILED` est terminal, porte un `errorCode` (catalogue dans `PRODUCT_SPEC_V2.md` §7-8) et un `errorMessage` technique (log interne, **jamais affiché tel quel à l'utilisateur** — `UX_FLOW.md` définit le message traduit par code).
- `COMPLETED` est terminal, porte `pdfUrl`, `zipUrl`, `completedAt`.

### Règle de décompte du crédit

Le crédit est décompté **exclusivement** lors de la transition `RENDERING → COMPLETED`, dans la même transaction base de données que l'écriture du statut `COMPLETED`. Aucune autre transition ne touche au solde de crédits. Ceci élimine toute possibilité de double-décompte ou de décompte sur un échec, y compris en cas de crash du worker entre deux étapes (le job reprend ou échoue, mais le crédit n'est jamais engagé avant la complétion réelle).

### Timeout

- Seuil global : **90 secondes** entre `QUEUED` et `COMPLETED`/`FAILED`
- Implémenté comme un job BullMQ avec `timeout` configuré ; au dépassement → transition forcée vers `FAILED` avec `errorCode = ERR_AI_TIMEOUT` (si le dépassement survient pendant `PROCESSING_AI`) ou un code dédié si pendant `RENDERING` (voir note ci-dessous)
- **Note d'implémentation** : si le rendu Puppeteer dépasse le timeout après une réponse LLM déjà reçue, utiliser `ERR_RENDER_FAILED` plutôt que `ERR_AI_TIMEOUT` — le code d'erreur doit refléter l'étape réellement en cause, pas l'étape où le timeout global a été détecté

---

## 2. Pipeline détaillé (étape par étape)

1. **Réception de la requête** (NestJS controller)
   - Validation front déjà passée (bornes 50-3000 mots), mais **revalidation serveur obligatoire** (ne jamais faire confiance au seul contrôle client)
   - Vérification du solde de crédits (`≥ 1`), sinon rejet immédiat `ERR_NO_CREDIT`, pas de job créé
   - Création de l'enregistrement `Generation` avec `status = QUEUED`
   - Enqueue du job BullMQ avec `generationId` comme seule charge utile (pas de duplication du texte source dans le message de queue — le worker relit depuis la base)

2. **Worker prend le job**
   - Transition `QUEUED → PROCESSING_AI`
   - Appel `LLMProvider.generateSlides(sourceText)` (interface définie dans `AI_PROMPT_SPEC.md`)

3. **Validation de la réponse LLM**
   - Voir `AI_PROMPT_SPEC.md` §Validation pour l'algorithme complet (parsing, bornes, retry, troncature)
   - Échec définitif à cette étape → `FAILED` avec le code approprié (`ERR_AI_TIMEOUT` / `ERR_AI_INVALID_RESPONSE` / `ERR_AI_SCHEMA_INVALID`)

4. **Persistance des slides**
   - Transition `PROCESSING_AI → RENDERING`
   - Écriture des lignes `Slide` (voir schéma §3) rattachées à la `Generation`, dans une transaction unique

5. **Rendu Puppeteer**
   - Une page HTML par slide (template unique, cf. `docs/DECISIONS.md` ADR-006), capture PNG 1080×1350
   - Assemblage des PNG en un PDF (une page par slide, même ordre)
   - Échec à cette étape → `FAILED`, `ERR_RENDER_FAILED`

6. **Upload storage**
   - Upload des PNG (individuels, pour le ZIP) + du PDF vers Supabase Storage (bucket dédié, voir §4)
   - Échec à cette étape → `FAILED`, `ERR_STORAGE_FAILED` (les fichiers locaux temporaires du worker sont nettoyés dans tous les cas, succès ou échec)

7. **Complétion**
   - Transition `RENDERING → COMPLETED`
   - Écriture de `pdfUrl`, `zipUrl` (le ZIP est généré à la volée à partir des PNG uploadés, soit au moment de l'upload soit à la demande — **décision : générer le ZIP à l'upload**, pas à la demande, pour éviter une latence supplémentaire au moment du téléchargement)
   - Décompte du crédit (transaction `CONSUMPTION` dans le ledger, voir §3)
   - Événement `generation_completed` (et `generation_activated` si premier succès du compte) journalisé dans `events`

---

## 3. Schéma de données

### `Generation`

```
Generation {
  id: uuid (PK)
  userId: uuid (FK → User)
  status: enum(QUEUED, PROCESSING_AI, RENDERING, COMPLETED, FAILED)
  sourceText: text
  sourceWordCount: integer
  slideCount: integer (nullable jusqu'à PROCESSING_AI résolu)
  sourceLanguage: string (nullable, ISO 639-1, rempli après réponse LLM)
  errorCode: string (nullable)
  errorMessage: text (nullable, usage interne uniquement)
  pdfUrl: string (nullable)
  zipUrl: string (nullable)
  creditTransactionId: uuid (nullable, FK → CreditTransaction, rempli seulement à COMPLETED)
  createdAt: timestamp
  updatedAt: timestamp
  completedAt: timestamp (nullable)
}
```

### `Slide`

```
Slide {
  id: uuid (PK)
  generationId: uuid (FK → Generation)
  order: integer
  title: string (≤ 60 caractères, contrainte DB)
  body: string (≤ 220 caractères, contrainte DB)
}
```
Contrainte d'unicité : `(generationId, order)` unique.

### `CreditTransaction` (ledger, append-only — jamais d'UPDATE, jamais de DELETE)

```
CreditTransaction {
  id: uuid (PK)
  userId: uuid (FK → User)
  amount: integer (positif pour GRANT_FREE/PURCHASE, négatif pour CONSUMPTION)
  type: enum(GRANT_FREE, PURCHASE, CONSUMPTION)
  reference: string (nullable — generationId si CONSUMPTION, stripeSessionId si PURCHASE)
  createdAt: timestamp
}
```

Le solde de crédits d'un utilisateur = `SUM(amount)` sur cette table pour `userId` donné. **Pas de colonne `credits` dénormalisée sur `User`** en P0 — le ledger est la seule source de vérité (évite les désynchronisations ; le coût de calcul d'un `SUM` est négligeable au volume MVP).

### `Event`

Voir `PRODUCT_SPEC_V2.md` §13 pour le schéma complet.

---

## 4. Storage

- **Provider : Supabase Storage** (tier gratuit — cohérent avec Supabase déjà présent dans la stack pour Auth/Postgres, zéro coût additionnel, zéro nouveau service à intégrer)
- Bucket privé (pas de bucket public) — accès via **URLs signées à expiration** (durée : 24h, renouvelable à la demande)
- Structure de chemin : `generations/{generationId}/slide-{order}.png`, `generations/{generationId}/carousel.pdf`, `generations/{generationId}/carousel.zip`
- `ERR_LINK_EXPIRED` géré côté API : si l'URL signée stockée en base a dépassé son expiration au moment d'un accès, régénérer une nouvelle URL signée à la volée plutôt que d'échouer silencieusement (cf. `docs/ACCEPTANCE.md`, déjà spécifié en V1 — confirmé ici)

---

## 5. Historique des générations

- Endpoint paginé, tri par `createdAt DESC`
- Pagination : curseur sur `createdAt` (pas d'offset — évite les incohérences si de nouvelles générations arrivent pendant la pagination), taille de page : 20
- Champs retournés par entrée : `id`, `status`, `createdAt`, `slideCount`, et **uniquement si `status = COMPLETED`** : URL de la vignette (première slide, `order = 1`)
- Aucune suppression, aucune archive en P0 (cf. `PRODUCT_SPEC_V2.md` §10)

---

## 6. Développement à budget 0€ — implications concrètes pour ce pipeline

- Le worker BullMQ + Redis tourne en local ou sur un tier gratuit Railway pendant le développement — aucune dépendance à un Redis managé payant
- Supabase Storage tier gratuit suffit largement au volume de développement/démo
- Le pipeline complet (étapes 1 à 7) doit être testable de bout en bout **sans aucune clé OpenRouter réelle** — le `MockProvider` (voir `AI_PROMPT_SPEC.md`) est le provider par défaut de tout environnement autre que production
