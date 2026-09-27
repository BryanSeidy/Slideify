# Security Boundaries — Slideify MVP

> **Note**: La extraction d'URL (P1) n'est PAS implémentée. Ce document définit les frontières de sécurité qu'une extraction URL devra respecter, ainsi que les protections existantes à renforcer.

## 1. Input Validation (Déjà Partiellement Implémenté)

### Source Texte Validation
| Check | Status | Implémentation |
|-------|--------|----------------|
| Taille min | ✅ | `GenerationInputSchema.min(80)` |
| Taille max | ✅ | `GenerationInputSchema.max(3000)` |
| Type | ✅ | Zod string validation |
| Injection | ✅ | Pas de HTML injection — texte passé à LLM (pas rendu direct) |

### Validation Pipeline
1. **Zod schema** — Validation à l'entrée API
2. **LLMResponse validation** — Zod schema après parsing LLM
3. **HTML escaping** — Dans renderer (`escapeHtml`)
4. **Credit check** — Avant création de génération

### Problèmes Identifiés
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Validation front-end (`generate/page.tsx`) mais pas backend — le contrôleur GenerationController ne valide pas le sourceText avec Zod |
| **EVIDENCE** | apps/api/src/generation/generation.controller.ts : `async create(@Body() body: { sourceText: string; userId: string })` — pas de Zod validation pipe |
| **IMPACT** | Injection ou texte invalide pourrait passer |
| **RECOMMENDATION** | Ajouter `ValidationPipe` NestJS ou Zod pipe pour valider sourceText |

---

## 2. SSRF Protection (Pour extraction URL futur)

### URL Extraction — Frontières Nécessaires

**À ne JAMAIS permettre** :

1. **Adresses IP privées**
   - `localhost` / `127.0.0.1` / `::1`
   - `10.0.0.0/8` (RFC 1918)
   - `172.16.0.0/12` (RFC 1918)
   - `192.168.0.0/16` (RFC 1918)

2. **Link-local**
   - `169.254.0.0/16`

3. **Métadonnées cloud**
   - `169.254.169.254` (AWS metadata)
   - `metadata.google.internal` (GCP metadata)
   - Endpoints similaires

4. **Protocoles internes**
   - `file://`
   - `gopher://`
   - `ftp://`
   - `dict://`

5. **Ports sensibles**
   - `22` (SSH)
   - `3306` (MySQL)
   - `5432` (PostgreSQL)
   - `6379` (Redis)

### Implémentation Recommandée (future URL extraction)

```typescript
function validateUrl(url: string): boolean {
  const parsed = new URL(url);

  // Only allow http/https
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }

  // Resolve hostname
  const hostname = parsed.hostname;

  // Check against blocked ranges
  if (isPrivateIP(hostname) || isLinkLocal(hostname)) {
    return false;
  }

  // Check cloud metadata endpoints
  if (hostname === '169.254.169.254') {
    return false;
  }

  return true;
}
```

---

## 3. Rate Limiting

### Actuel
- **NON implémenté**

### Recommandé (MVP)
| Endpoint | Limite | Fenêtre |
|----------|--------|---------|
| `/auth/magic-link` | 5 requêtes | / heure / IP |
| `/generations` (POST) | 20 requêtes | / minute / user |
| `/payment/webhook` | — | Idempotent (déduplication par ID) |

### Implémentation
- Utiliser `@nestjs/throttler` pour API
- BullMQ rate limiting pour worker
- Redis-backed counter pour distributed rate limiting

---

## 4. Idempotency

### Critique : Credit Consumption
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Credit débité APRÈS génération COMPLETED, mais sans transaction garantissant atomicité |
| **EVIDENCE** | apps/worker/src/index.ts : `await prisma.credit.update(...)` après génération COMPLETED — si crédit update fail, génération reste COMPLETED mais crédit non débité |
| **IMPACT** | Crédit gratuit possible |
| **RECOMMENDATION** | Utiliser `$transaction` pour atomicité generation COMPLETED + credit debit |

### Webhook Stripe Idempotence
| SEVERITY | OK |
|----------|------|
| **STATUS** | Idempotency via `webhookEvent.unique: [provider, eventType, id]` |
| **PROBLEM** | Unique constraint includes `eventType` — si Stripe envoie un même `id` avec `type` différent, doublon créé |
| **RECOMMENDATION** | Changer unique constraint à `[provider, id]` uniquement |

---

## 5. Authentication & Authorization

### Auth Actuel
- Magic link envoyé par email
- Utilisateur créé/mis à jour via `authenticateWithMagicLink`

### Problèmes
| SEVERITY | CRITICAL |
|----------|----------|
| **PROBLEM** | `authenticateWithMagicLink` crée un utilisateur mais **définit `credit.id` vide** (`userId: ''`) dans `prisma.credit.create` |
| **EVIDENCE** | auth.service.ts line 23 : `const credit = await this.prisma.credit.create({ data: { balance: config.freeCredits, userId: '' } });` |
| **IMPACT** | Foreign key violation, crédit pas lié au user |
| **RECOMMENDATION** | Créer user d'abord, puis credit avec `userId` correct, ou utiliser transaction |

| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Aucun JWT/session réel — `getMe` preprend `userId` depuis `@Body()` (client side) |
| **EVIDENCE** | auth.controller.ts line 26 : `@Get('me') async getMe(@Body('userId') userId: string)` |
| **IMPACT** | User peut usurper identité → crédit volatil ou consumption au nom d'autrui |
| **RECOMMENDATION** | Implémenter JWT auth guard avec token signé par AUTH_SECRET |

---

## 6. Secrets Management

### Actuel
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | `AUTH_SECRET` requis (min(1)) mais peut être vide dans `.env` — app plante au startup |
| **EVIDENCE** | env.ts : `AUTH_SECRET: z.string().min(1, 'AUTH_SECRET is required')` |
| **IMPACT** | Faille de sécurité en prod si secret faible/absent |
| **RECOMMENDATION** | Fournir secret généré aléatoirement pour dev, exiger force minimum en prod |

| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | `PAYMENT_SECRET_KEY` optionnel — webhook peut accepter des event sans vérification signature Stripe |
| **EVIDENCE** | payment.controller.ts : `handleWebhook` n'archive pas la signature Stripe |
| **IMPACT** | Webhook spoofable, crédit crédité frauduleusement |
| **RECOMMENDATION** | Vérifier signature Stripe `v1` avant traitement payload |

---

## 7. HTML Safety (Renderer)

| SEVERITY | MEDIUM |
|----------|--------|
| **PROBLEM** | `escapeHtml` personnalisée dans renderer n'inclut pas: null bytes, Unicode normalization, control chars |
| **EVIDENCE** | packages/renderer/src/render.ts : escapeHtml function |
| **IMPACT** | XSS possible si contenu LLM contient entités HTML spéciales |
| **RECOMMENDATION** | Utiliser bibliothèque `he` pour escaping |

---

## 8. Logging & Monitoring

| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Worker logger est un simple console.log wrapper — pas de structured logging ni log shipping |
| **EVIDENCE** | apps/worker/src/utils/logger.ts : utilise `console.log/console.error` |
| **IMPACT** | Difficulté de debugging en production |
| **RECOMMENDATION** | Utiliser Pino ou Winston avec JSON structured logging |

---

## 9. Error Handling (Erreurs Silencieuses)

### Worker
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Worker catch `error.message` mais si `error` est undefined → **crash** |
| **EVIDENCE** | apps/worker/src/index.ts line 97 : `logger.error(\`Job ${job.id} failed: ${error.message}\`)` — si `error` est null, `error.message` throw TypeError |
| **IMPACT** | Worker crash sans log, jobs restent bloqués |
| **RECOMMENDATION** | `logger.error((error as Error)?.message ?? 'Unknown error')` |

### API
| SEVERITY | HIGH |
|----------|------|
| **PROBLEM** | Controllers n'ont pas de error handling global — erreurs Prisma retournées raw à client |
|EVIDENCE** | auth.controller.ts : throws brut |
| **IMPACT** | Stack trace fuite à client |
| **RECOMMENDATION** | NestJS exception filter global masquant internals |

---

## 10. Summary des Actions Prioritaires

| Priorité | Action |
|----------|--------|
| 1 | Auth avec JWT guard réel (pas @Body) |
| 2 | Signature Stripe webhook validation |
| 3 | Transaction Prisma pour génération COMPLETED + credit debit |
| 4 | Zod validation pipes sur API endpoints |
| 5 | Logger structuré (Pino/Winston) |
| 6 | Gestion erreurs global NestJS (Exception filters) |
| 7 | HTML escaping robuste (lib `he`) |
| 8 | Rate limiting (ThrottlerGuard) |
| 9 | Fix credit.userId=' ' bug |
| 10 | Webhook idempotency key = [provider, id] not [provider, eventType, id]