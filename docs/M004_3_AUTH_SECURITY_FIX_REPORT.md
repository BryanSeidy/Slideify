# M004_3_AUTH_SECURITY_FIX_REPORT.md — Correctif P0 authentification (branche `fix/m004-recovery`)

**Contexte :** second audit indépendant Claude2 sur M004.2 — verdict CONDITIONAL GO, M005 BLOQUÉ.
Le retry BullMQ est confirmé réellement corrigé (re-vérifié cette session : suite
`worker-processor`, 13/13 passés, preuve de seconde exécution réelle après transitoire).
Restait un P0 critique : `POST /auth/login` (et l'ex-`magic-link`) émettait un JWT pour
n'importe quel email, sans aucune preuve de possession — usurpation triviale.

Aucun travail M005. Aucun renderer/PDF/PNG/scraping/paiement/nouveau provider IA.
Aucun invariant M004 affaibli pour faire passer les tests. Aucune protection retirée.

---

## 1. Root cause

1. `AuthService.authenticateWithMagicLink(email)` créait (ou retrouvait) un compte à partir
   du seul email et `AuthController.login(email)` appelait `login(userId, email)` dessus :
   **connaître l'email suffisait à obtenir un JWT signé pour ce compte**.
2. Aucun secret partagé (mot de passe), aucun lien magique réellement envoyé/vérifié,
   aucun OTP : le nom `magic-link` était un leurre, l'endpoint créait la session directement.
3. Les tests M004.2 couvraient ce comportement (`login('new@example.com')` → JWT) et le
   présentaient comme volontaire : la vulnérabilité était donc verrouillée par la suite.
   Ces tests ont été **supprimés** (pas adaptés) car ils validaient précisément la faille.

## 2. Architecture retenue

**Email + mot de passe, 100 % local, zéro budget** (`bcryptjs`, pur JS, aucune dépendance
native, aucun service externe) :
- Rejeté : magic-link/OTP réel (exige un envoi d'email = fournisseur externe/payant,
  incompatible avec la contrainte MVP onsite) ; OAuth (fournisseurs externes, hors périmètre) ;
  PINdevice/service SaaS (idem).
- `bcryptjs` plutôt que `bcrypt`/`argon2` : pas de compilation native (fiabilité Windows/CI),
  coût `10` adapté au MVP local (note : relever à 12 si les logins deviennent une cible).
- `POST /auth/register { email, password }` → `201 { userId, email, credits }`
  (**sans token** : register et login restent conceptuellement distincts).
- `POST /auth/login { email, password }` → `200 { accessToken, userId, email, credits }`
  uniquement après `bcrypt.compare` réussi.
- `GET /auth/me` inchangé (identité = JWT uniquement).
- `POST /auth/magic-link` et `authenticateWithMagicLink` **supprimés** (surface d'usurpation).
- Mots de passe : jamais en clair (colonne `passwordHash` seule), jamais loggés, jamais
  retournés par l'API (les réponses register/login ne contiennent ni hash ni mot de passe).
- Anti-énumération : login inconnu et login erroné → **même** `401 { code: INVALID_CREDENTIALS,
  message: 'Email ou mot de passe invalide.'` (même statut, même corps) **et** même coût
  bcrypt (comparaison contre un hash factice précalculé quand l'utilisateur est inconnu).
  Register en double → `409 { code: EMAIL_TAKEN }` (inévitable et standard : l'unicité
  l'imposerait de toute façon en 500 sinon).
- JWT : secret `AUTH_SECRET` (requis au boot via `@slideify/config`), expiration 7 j
  conservée (résiduel : envisager 24 h + refresh avant production publique).
- Crédits de bienvenue : `+3 MANUAL_GRANT/signup_bonus` **dans la même transaction** que la
  création du compte → atomicité ; idempotence par `User.email @unique` (un second register
  échoue avant toute écriture). Plus aucun crédit n'est attribuable avec un simple email
  sans mot de passe, et deux comptes exigent deux emails réels distincts.

## 3. Changements

| Fichier | Changement |
|---------|------------|
| `packages/schema/prisma/schema.prisma` | `User.passwordHash String` (requis, commentaire anti-clair) |
| `packages/schema/prisma/migrations/20251006_m004_3_password_hash/migration.sql` | **Créée** (`ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT NOT NULL`) — écrite à la main car `migrate diff --from-migrations` exige une shadow-DB PG indisponible ici ; instruction `NOT NULL` sûre : aucune base de production n'existe (bases de dev antérieures : `migrate reset`) |
| `apps/api/src/auth/auth.service.ts` | **Réécrit** : `register` (409 si pris, hash coût 10, user+grant en transaction), `login(email,password)` (dummy-hash + 401 générique), suppression de `authenticateWithMagicLink` et de l'ancien `login(userId,email)` ; `BCRYPT_COST` exporté |
| `apps/api/src/auth/auth.controller.ts` | `POST register` (201, validation email + password 8–128, 400/409), `POST login` (200/400/401), suppression de `magic-link` ; `GET me` inchangé |
| `apps/api/package.json` (+ lockfile) | Ajout `bcryptjs`, `@types/bcryptjs` |
| `tests/auth.test.ts` | **Réécrit** (voir §4 ; zéro test email-seul→JWT restant) |
| `package.json` (+ lockfile) | Ajout devDeps racine `bcryptjs`, `@types/bcryptjs` (imports directs des tests) ; `test` borné `--maxWorkers=2 --workerIdleMemoryLimit=512MB` (OOM constaté en parallèle libre, voir §5) |
| `jest.config.js` | inchangé par M004.3 (decorators déjà ajoutés en M004.2) |

Non touchés (vérifié) : `generation.controller/service` (identité déjà JWT-only),
`jwt.guard`, `AuthModule`, `AppModule`, worker, packages partagés, web (aucun appel auth).

## 4. Tests ajoutés / modifiés

`tests/auth.test.ts` réécrit (12 tests, tous exigeant un mot de passe vérifié) :
- Wiring : module compile + expose `register/login/getMe`, pas de `sendMagicLink`.
- Register valide → hash salé (≠ clair, `bcrypt.compare` OK), `+3` unique, réponse sans token ni hash.
- Même mot de passe → deux hashs différents (sel par utilisateur).
- Email dupliqué → 409, toujours 1 seul grant.
- Email/mot de passe invalides → 400, 0 compte, 0 écriture ledger.
- Login correct → JWT vérifiable (`sub`/`email`).
- **Email seul de la victime + mot de passe attaquant → 401, aucun JWT.**
- Inconnu vs erroné → réponses **strictement égales** (`{status:401, code:INVALID_CREDENTIALS,…}`).
- Entrées malformées → 400 (jamais 401/500).
- `getMe` = identité JWT ; guard : valide→`true`+`req.user`, absent/malformé/forgé→`false` sans `req.user`.

Tests M004.2 conservés intacts (worker 13, llm 17, generation 6, schema 2) : aucun invariant
affaibli, aucune protection retirée.

## 5. Résultats réels

Commande tests exacte : `pnpm test` → `jest --config jest.config.js --maxWorkers=2 --workerIdleMemoryLimit=512MB`

| Suite | Tests (résultat Jest exact, `--verbose`) |
|-------|------------------------------------------|
| `llm.test.ts` | 17 passés |
| `worker-processor.test.ts` | 13 passés (dont preuve de ré-exécution après transitoire) |
| `schema.test.ts` | 2 passés |
| `generation.test.ts` | 6 passés |
| `auth.test.ts` | 12 passés |
| **Total Jest** | **5 suites passées, 50 tests passés, 0 fail, 0 skip** |

Note sur l'écart 46 vs 44 relevé par Claude2 : les deux chiffres dataient d'avant la réécriture
(9 tests auth à l'époque). L'état actuel mesuré par Jest est **50/50** (auth réécrite : 12 tests).
Seul le chiffre produit par Jest ci-dessus fait foi.

| # | Commande | Résultat |
|---|----------|----------|
| 1 | `pnpm install` (+ `bcryptjs`, `@types/bcryptjs`) | **PASS** |
| 2 | `prisma generate` (`pnpm --filter @slideify/schema db:generate`) | **PASS** (après ajout du champ ; régénéré) |
| 3 | `pnpm -r --if-present typecheck` (8 projets) | **PASS** |
| 4 | `pnpm -r --if-present lint` | **PASS** (via `tsc`, réserve M004.1 inchangée) |
| 5 | `pnpm test` | **PASS** — 5 suites, 50/50 |
| 6 | `pnpm -r --if-present build` (8 projets, Next 9 pages) | **PASS** |
| 7–10 | `migrate deploy`, API+worker live, E2E auth réel, retry transitoire réel | **NOT EXECUTED** — daemon Docker inactif (re-vérifié), Redis absent, PG-18 local sans identifiants non interactifs (mot de passe demandé en interactif, abandonné sans saisie) |

Incident de session (transparence) : première exécution `pnpm test` après ajout de bcrypt —
mémoire épuisée (workers Jest parallèles, `FATAL ERROR: JavaScript heap out of memory`,
suite `schema.test.ts` tuée par SIGTERM, `auth.test.ts` en échec de compilation `bcryptjs`
introuvable à la racine). Corrigé par : ajout des deps à la racine + `--maxWorkers=2
--workerIdleMemoryLimit=512MB`. Relance : 50/50 verts. Les chiffres rapportés sont ceux des
exécutions réussies complètes, pas des partielles.

## 6. Risques résiduels

- R-A. E2E live (register→login→JWT→POST→worker→COMPLETED + retry transitoire réel) : à rejouer
  dès qu'une infra PG+Redis existe ; les preuves actuelles sont unitaires/intégration sans réseau.
- R-B. `BCRYPT_COST=10` : relever à 12 si exposition publique (coût CPU login).
- R-C. JWT 7 j sans refresh/rotation/révocation : acceptable MVP local, à durcir (24 h + refresh,
  denylist) avant ouverture.
- R-D. `409 EMAIL_TAKEN` au register révèle l'existence d'un email (standard et inévitable avec
  unicité ; le login, lui, ne révèle rien).
- R-E. Aucun rate-limit sur `/auth/*` (IN-08, P1 antérieur) : brute-force non freiné au niveau
  applicatif — à ajouter (throttler) avant exposition.
- R-F. Migration `passwordHash NOT NULL` : bases de dev pré-M004.3 à réinitialiser (`migrate reset`).
- R-G. D-11 d'origine (timing d'attribution des crédits) : résolu par construction (grant atomique
  au register, jamais d'émission sans compte à mot de passe).

## 7. Comparaison avec le P0 découvert par Claude2

| Point du P0 | État |
|-------------|------|
| Email seul → JWT | **Éliminé** : aucun chemin de code ne signe sans `bcrypt.compare` réussi (vérifié par recherche : seul `AuthService.login` signe, et il compare d'abord) |
| Tests verrouillant la faille | **Supprimés**, remplacés par des tests prouvant l'exigence du mot de passe (dont attaque simulée) |
| userId client comme identité | **Absent** : register/login ne prennent que email+password ; le reste lit `req.user` |
| getMe via JWT | **Inchangé et testé** |
| Contraintes MVP (zéro budget, local) | **Respectées** : `bcryptjs` pur JS, aucune infra externe, aucun nouveau provider |

## 8. Verdict

**READY FOR RE-AUDIT** — l'usurpation triviale par email seul est supprimée au niveau du modèle
(pas des tests), avec preuves exécutées : 50/50 tests, typecheck/lint/build verts, client Prisma
régénéré. Le ré-audit devra rejouer le flux live (register→login→JWT→route protégée, attaque
par email seul, retry BullMQ) dès qu'une infra PG + Redis est disponible.
