# Generation Lifecycle — Slideify MVP

## États et Transitions

```
QUEUED → PROCESSING_LLM → PROCESSING_RENDER → COMPLETED
              ↓                 ↓
            FAILED ←───────────┘
```

## États

| État | Description | Durée moyenne |
|------|-------------|---------------|
| `QUEUED` | Job en attente dans la file d'attente BullMQ | 0-5s |
| `PROCESSING_LLM` | Appel au provider LLM (MockProvider ou OpenRouter) | 1-5s |
| `PROCESSING_RENDER` | Rendu Puppeteer HTML/CSS → PNG/PDF | 3-10s |
| `COMPLETED` | Génération terminée, crédits déboursés | instantané |
| `FAILED` | Erreur irrécupérable, crédit non décompté | instantané |

---

## Transitions Détaillées

### Transition 1: QUEUED → PROCESSING_LLM

**Source** : Job créé par l'API

**Destination** : Worker commence à traiter

**Déclencheur** : BullMQ Worker prend le job

**Conditions** :
- Job existe dans la file
- Démon Redis accessible
- Generation record existe avec status = QUEUED

**Actions** :
1. Mettre à jour `generations.status` = `PROCESSING_LLM`
2. Mettre à jour `generations.startedAt` = `now()`

**Erreurs possibles** :
- Redis non accessible → job reste en QUEUED, retry automatique
- Génération introuvable → marquer FAILED, notifier

**Retry** : Oui, jusqu'à 3 fois (config BullMQ)

---

### Transition 2: PROCESSING_LLM → PROCESSING_RENDER

**Source** : Réponse LLM reçue

**Destination** : Validation + Rendu

**Déclencheur** : `LLMProvider.generate()` retourne une réponse

**Conditions** :
- Réponse valide JSON
- 5..10 slides
- Chaque slide: title ≤ 60 chars, body ≤ 220 chars
- Ordre séquentiel 1..N

**Actions** :
1. Valider la réponse JSON
2. Tronquer (si besoin) body > 220 chars (dernier mot complet)
3. Appeler `renderSlides()` pour PNG
4. Mettre à jour `generations.status` = `PROCESSING_RENDER`
5. Stocker les PNG dans storage (URL signée)

**Erreurs possibles** :
- JSON invalide → retry une fois avec prompt de correction, puis FAILED
- Schema invalide (slides manquantes, bornes dépassées) → FAILED
- Erreur de rendu Puppeteer → FAILED

**Retry** :
- JSON parsing : 1 retry avec prompt de correction
- Autres erreurs : pas de retry, FAILED

---

### Transition 3: PROCESSING_RENDER → COMPLETED

**Source** : PNG générés, prêts à être stockés

**Destination** : Génération complète

**Déclencheur** : Upload réussi dans le storage

**Conditions** :
- Tous les PNG uploadés
- URLs valides et accessibles

**Actions** :
1. Stocker URLs dans `outputs` (format PNG)
2. Créer fichier ZIP (optionnel, à implémenter)
3. Créer PDF (optionnel, à implémenter)
4. Mettre à jour `generations.status` = `COMPLETED`
5. Mettre à jour `generations.completedAt` = `now()`
6. **Débiter crédit** via CreditTransaction (append-only)
7. Créer `GenerationEvent` si première génération COMPLETED (activation)

**Erreurs possibles** :
- Upload échoué → FAILED
- Erreur storage → FAILED

**Retry** : Non, FAILED

---

### Transition vers FAILED (de n'importe quel état)

**Déclencheur** : Erreur irrécupérable

**Conditions** :
- Après max retries
- Erreur critique (non récupérable)

**Actions** :
1. Mettre à jour `generations.status` = `FAILED`
2. Enregistrer `generations.error` = code erreur
3. **NE PAS débiter crédit**

**Erreurs possibles** :
- LLM_ERROR (provider unreachable, out of quota)
- INVALID_RESPONSE (JSON malformé après retry)
- RENDER_ERROR (Puppeteer crash, template bug)
- STORAGE_ERROR (disk full, permission)

---

## Idempotentité

### Pourquoi ?
- Double clic bouton "Générer"
- Webhook Stripe reçu plusieurs fois
- Worker redémarré, job reruné

### Comment ?
1. **Job ID unique** : BullMQ génère des job IDs uniques
2. **Vérification 상태 перед traitement** : Vérifier si job déjà traité
3. **Webhook idempotent** : Enregistrer `webhookEvent` avec `id` unique (Stripe session ID)
4. **Credit debit idempotent** : Vérifier si crédit déjà débité avant `decrement`

### Pattern :
```typescript
// Dans le worker
const existing = await prisma.generation.findUnique({
  where: { id: generationId, status: 'COMPLETED' }
});
if (existing) return; // Job déjà traité
```

---

## Événements Produits

| Événement | Table | Trigger |
|-----------|-------|---------|
| génération_créée | generation (status=QUEUED) | POST /generations |
| llm_débuté | generation (status=PROCESSING_LLM) | Worker prend job |
| llm_terminé | generation (status=PROCESSING_RENDER) | Réponse LLM valide |
| rendu_débuté | generation (status=PROCESSING_RENDER) | Worker appelle Puppeteer |
| rendu_terminé | generation (status=COMPLETED) | PNG uploadés |
| crédit_débité | credit_transactions | Transcription depuis generation |
| utilisateur_activé | generation_events | Première génération COMPLETED |
| erreur | generation (status=FAILED, error) | Toute erreur critique |

---

## Timeout Handling

**Seuil max** : 90 secondes (ACCEPTANCE.md)

**Détection** :
- Job BullMQ > 90s sans update status
- Heartbeat ou polling status API

**Action** :
- Marquer `FAILED`
- Message expditif : "La génération prend plus de temps que prévu"
- Crédit non décompté

---

## Edge Cases

| Cas | Traitement |
|-----|------------|
| User quitte page pendant traitement | Job continue, visible en "En cours" |
| Worker plante | BullMQ re-dispatch le job |
| Redis down | Jobs s'accumulent, reconnection automatique |
| DB down | Worker fail, retry BullMQ |
| Storage down | Marquer RENDER_ERROR, retry possible |
| LLM timeout | Retry 1x, puis FAILED |
| User supprimé pendant génération | Transaction rollback, crédit non débité |

---

## Monitoring

**Métriques à exporter** :
- `generation_count{status}` – compteur par statut
- `generation_duration_seconds` – durée moyenne
- `llm_errors_total` – erreurs LLM
- `render_errors_total` – erreurs Puppeteer
- `processing_time_seconds` – temps de fichier

**Alerting** :
- > 5% jobs FAILED → alerter
- > 10% temps de traitement > 30s → alerter
- Redis indisponible → alerter critique