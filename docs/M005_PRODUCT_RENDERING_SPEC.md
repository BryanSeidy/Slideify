# M005_PRODUCT_RENDERING_SPEC.md

**Mission** : M005-PRODUCT — Result Experience + Rendering Contract
**Auteur** : Claude1 (Product Lead) — **Date** : 2026-09-30
**Destinataire** : OpenCode (implémentation)
**Nature** : contrat produit de l'étape `Slide[] validé → carrousel visuel → PDF/PNG`. Aucun code, aucune implémentation technique.

---

## 0. Périmètre, méthode, changement de format assumé

**Lu** : `PRODUCT.md`, `PRODUCT_SPEC_V2.md`, `GENERATION_SPEC.md`, `AI_PROMPT_SPEC.md`, `UX_FLOW.md`, `AI_CONTRACT.md`, `M004_PRODUCT_REVIEW.md`, `M004_ARCHITECTURE_REVIEW.md`, `M004_QA_SECURITY.md` (`origin/develop@1ca870a`).

**Format retenu : portrait 1080×1350 (4:5)**, conforme à `GENERATION_SPEC.md`/`UX.md` (V1). Le brief M005 évoquait un canevas carré 1080×1080 ; après discussion (voir R-15), le format portrait est confirmé — il occupe davantage de hauteur de flux sur Instagram et LinkedIn (meilleure visibilité au scroll), ce qui sert directement l'objectif d'adoption du MVP. Aucun changement de décision par rapport à V1 : ce document applique le format déjà en vigueur, il ne le rouvre pas.

La recommandation « corps ≥ 40 px, titre ≥ 64 px » (`M004_PRODUCT_REVIEW.md` §5.3) avait déjà été calculée pour ce canevas 1080×1350 — reconfirmée ci-dessous (§2.5) sans changement.

**Ce document ne modifie aucune décision produit déjà tranchée en M004** (états, codes d'erreur, moment du débit de crédit, activation) : il les reprend telles quelles, sans les rouvrir.

---

## 1. Result experience

### 1.1 Ce que l'écran doit afficher (reprend `UX_FLOW.md` §6, précisé)

| Élément | Contrat |
|---|---|
| **Nombre de slides** | Affiché en position « n / N » sur la slide visible (ex. « 3 / 7 »), pas de compteur séparé ailleurs sur l'écran. |
| **Navigation** | Flèches précédent/suivant + swipe tactile. Boucle interdite (à la dernière slide, « suivant » est désactivé, pas de retour à la première). |
| **Preview** | L'image réellement téléchargeable (le PNG rendu), pas un second rendu HTML indépendant — ce que l'utilisateur voit à l'écran est strictement ce qu'il publie. |
| **Titre / contenu** | Rendus **dans** l'image de preview (ils font partie du visuel, pas un texte HTML à côté) — cohérent avec « aperçu = fichier réel ». |
| **État de génération** | Uniquement `COMPLETED` amène sur cet écran (cf. `UX_FLOW.md` §1, flux linéaire) — aucun état de chargement à afficher ici ; les états `FAILED` sont traités à l'écran de suivi (§8, repris de M004). |
| **Téléchargement** | Deux boutons : « Télécharger les images (ZIP) », « Télécharger le PDF ». Actifs dès l'affichage de l'écran (les fichiers existent déjà — décision « export à `COMPLETED` », voir §6). |
| **Crédits** | Pastille de solde, à jour **après** le débit (`PRODUCT_SPEC_V2.md` confirmé par `M004_PRODUCT_REVIEW.md` §7). |
| **Retour** | Lien vers le Dashboard. |

### 1.2 Ce qui reste hors de cet écran (rappel, ne pas ajouter)

Édition du texte, réordonnancement, régénération d'une seule slide, partage direct, copie du texte en clair, légendes/hashtags. Ces éléments sont hors scope MVP (`BACKLOG.md`).

---

## 2. Slide visual contract (1080×1350)

### 2.1 Anatomie de la slide (structure unique, pas de variante)

```
┌──────────────────────────────────────┐
│  n/N                        (coin)    │  ← index, discret
│                                        │
│                                        │
│              TITRE                    │  ← bloc titre
│                                        │
│              corps                    │  ← bloc corps
│                                        │
│                                        │
│             Slideify                  │  ← footer, discret
└──────────────────────────────────────┘
```

Une seule structure pour **toutes** les slides d'un carrousel, y compris la première (accroche) et la dernière (conclusion) — pas de gabarit « slide de titre » différent. La distinction accroche/conclusion est une affaire de contenu (généré par le LLM), pas de mise en page.

### 2.2 Hiérarchie visuelle

1. **Titre** — élément dominant, lu en premier
2. **Corps** — support, lu en second, contraste réduit par rapport au titre
3. **Index (n/N) et footer** — discrets, jamais en compétition visuelle avec le contenu

### 2.3 Spacing (proportions, pas de valeurs pixel figées au-delà de ce qui est nécessaire)

| Zone | Règle |
|---|---|
| **Marge de sécurité** | Uniforme sur les 4 côtés (voir §2.6) — aucun élément de texte ne touche le bord |
| **Espace entre titre et corps** | Un espacement net et constant, visuellement distinct du saut de ligne interne à un bloc (le titre et le corps ne doivent jamais sembler être un seul paragraphe) |
| **Centrage vertical** | Le bloc titre+corps est centré verticalement dans la zone de contenu (entre la marge de sécurité haute et basse) — pas collé en haut ni en bas |
| **Alignement horizontal** | Centré, cohérent avec l'esthétique carrousel professionnel déjà retenue (`docs/DECISIONS.md` ADR-006) |

### 2.4 Typographie — règle unique et cohérente

| Élément | Taille (canevas 1080 px) | Poids | Interligne |
|---|---|---|---|
| **Titre** | **64–72 px** | Gras (700) | 1.25–1.3 |
| **Corps** | **40–44 px** | Normal (400–500) | 1.45–1.5 |
| **Index (n/N)** | 20–24 px | Normal, opacité réduite | — |
| **Footer** | 18–20 px | Normal, opacité réduite | — |

**Une seule taille par élément est retenue à l'implémentation** (pas une fourchette dynamique par slide) — la fourchette ci-dessus borne le choix d'OpenCode, elle n'introduit pas de variation entre slides d'un même carrousel ni d'une génération à l'autre. Choisir une valeur fixe dans chaque fourchette et la documenter dans `DECISIONS.md`.

### 2.5 Vérification de la recommandation « corps ≥ 40 px / titre ≥ 64 px »

Reprise du calcul de `M004_PRODUCT_REVIEW.md` §5.3 (déjà fait pour ce canevas 1080×1350, confirmé sans changement) :

- **Lisibilité à l'échelle d'affichage réel** : une image de 1080 px de large s'affiche à ~360–390 px sur un flux mobile (échelle ≈ 0,35). Un corps à 40 px descend à ~14 px à l'écran, un titre à 64 px à ~22–23 px — seuils de lisibilité mobile respectés, cohérent avec la conclusion M004.
- **Tenue du contenu maximal dans le cadre** : avec une marge de sécurité de 80 px par côté (§2.6), la largeur de texte utile est d'environ 920 px et la hauteur utile d'environ 1190 px. À 40–44 px, une ligne de corps contient ~45–55 caractères. Les 220 caractères maximum du corps (`AI_CONTRACT.md`) tiennent donc en 4 à 5 lignes, soit ~300–330 px de hauteur avec l'interligne ci-dessus — largement dans le budget vertical disponible, et plus confortable encore que sur un canevas carré grâce à la hauteur supplémentaire (voir §4.3, plafond de 6 lignes).
- **Conclusion** : la recommandation **corps ≥ 40 px / titre ≥ 64 px** est confirmée pour 1080×1350, sans ajustement. Le template actuel du code (18 px / 36 px) reste **non conforme** et doit être remplacé.

### 2.6 Safe area

- **Marge de sécurité uniforme : 80 px** sur les 4 côtés du canevas 1080×1350 (zone de contenu utile : 920×1190 px).
- Objectif produit : garantir qu'aucun texte ne soit rogné en cas de recadrage léger par une plateforme, et préserver une respiration visuelle cohérente avec la perception de qualité pro visée par le MVP (`PRODUCT.md` §Critère de succès).
- L'index (n/N) et le footer peuvent empiéter légèrement dans la marge de sécurité (ce sont des éléments décoratifs, pas du contenu informationnel critique), mais restent à au moins 40 px de tout bord.

---

## 3. Typography (résumé exécutable, complète §2.4)

- Une seule famille de police pour tout le template (titre et corps), cohérente avec `docs/DECISIONS.md` ADR-006 (« contrôle total du layout »).
- Pas de tailles de police variables selon la longueur du texte (pas d'auto-shrink) — la taille est fixe, définie une fois pour toutes ; c'est la politique d'overflow (§4) qui absorbe les écarts de longueur, jamais un ajustement dynamique de la police. *Justification* : un auto-shrink ferait varier l'aspect visuel d'une slide à l'autre au sein d'un même carrousel selon la longueur du texte généré, ce qui casse la cohérence visuelle qui est le principal argument de vente du template unique.
- Couleur du texte : contraste fort et constant sur le fond du template (déjà tranché en V1, ADR-006 — ce document ne rouvre pas le choix de palette).

---

## 4. Overflow policy (titre et corps)

### 4.1 Deux niveaux de protection, dans cet ordre

1. **Niveau contenu (déjà en vigueur, ratifié M004)** : le LLM est contraint à 60 caractères (titre) / 220 caractères (corps). Un dépassement mineur est tronqué au dernier mot complet + ellipse (`AI_CONTRACT.md`, `M004_PRODUCT_REVIEW.md` D-04). Cette étape a lieu **avant** le rendu — elle garantit que le rendu ne reçoit jamais un texte excessivement long.
2. **Niveau rendu (nouveau, objet de ce document)** : même avec un texte dans les bornes, le retour à la ligne (word wrap) peut produire plus de lignes que prévu selon les mots réels (un mot très long, une langue plus dense). Le rendu doit donc avoir sa propre garde-fou, indépendante du comptage de caractères.

### 4.2 Word wrapping

- Retour à la ligne standard sur les espaces, respectant les mots entiers (jamais de coupure au milieu d'un mot).
- Un mot unique plus large que la zone de contenu (URL très longue, mot composé sans espace) est autorisé à déborder en coupure de dernier recours plutôt que de casser la mise en page — cas limite, non bloquant pour le MVP.

### 4.3 Maximum de lignes visibles

| Élément | Lignes maximum |
|---|---|
| **Titre** | **3 lignes** |
| **Corps** | **6 lignes** |

Ces plafonds sont calculés larges par rapport à la tenue réelle du contenu maximal (§2.5 : ~4-5 lignes pour 220 caractères) — ils servent de filet de sécurité, pas de contrainte qui se déclenche en usage normal.

### 4.4 Comportement si le contenu est trop long malgré tout

Si, après word wrap, le texte dépasse le nombre de lignes maximum (cas résiduel, ne devrait pas se produire si §4.1 fonctionne) :
- **Troncature visuelle avec ellipse sur la dernière ligne visible** (même principe qu'au niveau contenu : dernier mot complet + « … »).
- **Jamais** de réduction automatique de la taille de police (contredit §3).
- **Jamais** de débordement hors du canevas (le texte ne doit jamais sortir de la zone de sécurité).
- Ce cas doit être journalisé côté technique (pour détecter si les bornes de caractères de `AI_CONTRACT.md` sont mal calibrées) mais **n'est pas visible par l'utilisateur** comme une erreur — la slide reste utilisable, juste tronquée.

---

## 5. Template

### 5.1 Un seul template — confirmé, aucune variante

- Aucune option de choix de template en MVP (déjà tranché `PRODUCT.md`, `BACKLOG.md` P1-3).
- **Aucune variante structurelle non plus** : pas de gabarit différent pour la première slide (« hook ») ou la dernière (« conclusion/CTA »), pas de variante selon le nombre de slides (5 vs 10), pas de variante selon la longueur du texte. Une seule structure HTML/CSS, réutilisée N fois avec un contenu différent (`slide.order`, `slide.title`, `slide.body`).
- *Justification* : chaque variante est une surface de test et de bug supplémentaire pour un MVP à livrer vite ; la cohérence visuelle stricte (même structure partout) sert directement le critère de succès du MVP (« qu'il publierait tel quel »).

### 5.2 Dimensions (verrouillées)

- **Canevas : 1080×1350 px**, ratio 4:5.
- Identique pour le PNG de chaque slide et pour chaque page du PDF (§6) — un seul jeu de dimensions dans tout le pipeline, pas de conversion de format entre PNG et PDF.

### 5.3 Ce qui varie entre slides (et rien d'autre)

- Le texte du titre
- Le texte du corps
- L'index affiché (n/N)

Tout le reste (position, taille, police, couleurs, marges, footer) est strictement identique sur les N slides d'une même génération.

---

## 6. Export contract (PDF, PNG) — niveau produit, sans implémentation

### 6.1 Quand l'export a lieu

Les exports (PNG individuels, PDF assemblé) sont produits **pendant le pipeline de génération**, avant le passage à `COMPLETED` — pas à la demande au moment du clic de téléchargement. *Rappel, déjà tranché en V1/V2* : ceci garantit un téléchargement instantané sur l'écran Résultat, sans état de chargement supplémentaire à ce moment-là. Ce document ne rouvre pas cette décision ; il en confirme la portée pour le format 1080×1350.

### 6.2 PNG

| Contrat | Valeur |
|---|---|
| Un fichier par slide | Oui, N fichiers PNG pour N slides |
| Dimensions | 1080×1350 px, identiques pour toutes |
| Contenu | Rendu exact du template avec le titre/corps de la slide, tel qu'affiché en preview (§1.1) |
| Ordre / nommage produit | Doit permettre un tri trivial dans l'ordre du carrousel une fois extrait du ZIP (ex. numérotation à deux chiffres, `01`, `02`…) — le détail d'implémentation (nom de fichier exact) reste à OpenCode, la **garantie produit** est l'ordre correct après extraction |

### 6.3 PDF

| Contrat | Valeur |
|---|---|
| Nombre de pages | Exactement N, une page par slide, dans l'ordre `order` |
| Dimensions de page | Format 4:5 cohérent avec le canevas 1080×1350 (pas de format A4/lettre avec marges blanches — le PDF est un « livrable visuel », pas un document texte) |
| Contenu par page | Identique au PNG correspondant — même règle « ce qui est prévisualisé est ce qui est livré » |
| Usage prévu | Présentation feuilletable (l'utilisateur peut la partager telle quelle en dehors des réseaux sociaux, ex. par email) — pas d'objectif d'impression |

**Écart constaté par rapport à ce contrat** (`M004_QA_SECURITY.md` §0.1-2, -9) : `renderPDF` actuel ne rend que la première slide, en A4. Non conforme — à corriger : le PDF doit contenir toutes les slides, au format 4:5 du canevas.

### 6.4 ZIP

- Contient exactement les N fichiers PNG de la génération, rien d'autre (pas le PDF à l'intérieur du ZIP — les deux sont des téléchargements distincts, cf. §7).

---

## 7. Download UX

| Élément | Contrat |
|---|---|
| **Ce qui est téléchargeable** | Exactement deux livrables au choix : le ZIP des PNG, ou le PDF. Rien d'autre (pas de téléchargement d'une slide individuelle, pas de format additionnel — cohérent avec `BACKLOG.md`, hors scope) |
| **Disponibilité** | Les deux boutons sont actifs dès l'affichage de l'écran Résultat (export déjà fait, §6.1) — pas d'attente perçue par l'utilisateur au clic |
| **Cas rare (fichier pas encore prêt)** | Si une race condition fait que les fichiers ne sont pas encore disponibles en storage à l'ouverture de l'écran, état transitoire déjà spécifié dans `UX_FLOW.md` §6 (« Préparation des fichiers… ») — ce document ne le redéfinit pas |
| **Lien expiré** | Régénération silencieuse (`GENERATION_SPEC.md` §4, `M004_PRODUCT_REVIEW.md` §5.4) — jamais présenté comme une erreur |

---

## 8. Error states (génération / rendu / export)

Reprend et complète la table de `M004_PRODUCT_REVIEW.md` §6.2, sans en changer les codes ni les principes (aucun code technique affiché, message unique par famille, « Aucun crédit n'a été débité », bouton « Réessayer », texte source préservé).

| Situation | Ce que voit l'utilisateur | Code (ratifié M004) |
|---|---|---|
| **Génération FAILED** (échec LLM : timeout, réponse invalide, schéma hors bornes) | « Une erreur est survenue pendant l'analyse de votre texte. Réessayez. » | `LLM_ERROR` / `INVALID_RESPONSE` / `MALFORMED_OUTPUT` / `TIMEOUT` |
| **Rendering FAILED** (le moteur de rendu ne parvient pas à produire les PNG — crash, template cassé) | « Une erreur est survenue pendant la mise en page de votre carrousel. Réessayez. » | `RENDER_ERROR` |
| **Export FAILED** (les PNG existent mais l'assemblage PDF ou l'upload échoue) | **Même message que « Rendering FAILED »** — voir justification ci-dessous | `RENDER_ERROR` (pas de nouveau code) |

**Justification de ne pas créer de code d'erreur `EXPORT_ERROR` séparé** : du point de vue de l'utilisateur, « le rendu de mon carrousel a échoué » est un seul événement, qu'il s'agisse du PNG, du PDF ou du ZIP — il n'a aucune action différente à faire selon la cause exacte (toujours « Réessayer »). Introduire un code de plus complique le catalogue déjà signalé comme fragile par `M004_QA_SECURITY.md` (SC-02) sans bénéfice pour l'utilisateur. Si l'échec de stockage (upload) doit être distingué en interne pour le monitoring, `STORAGE_ERROR` (déjà ratifié) couvre ce cas — mais l'utilisateur voit le même message que pour `RENDER_ERROR` dans les deux cas, car la distinction n'a pas de valeur produit.

Dans tous les cas ci-dessus : **aucun crédit débité** (invariant confirmé, `M004_PRODUCT_REVIEW.md` §7), génération marquée `FAILED`, retour au générateur avec le texte préservé.

---

## 9. Mobile behavior

L'écran Résultat doit rester pleinement exploitable sur un écran mobile (c'est le contexte d'usage principal du persona, `PRODUCT.md`) :

| Aspect | Contrat |
|---|---|
| **Preview** | Une seule slide affichée à la fois, à pleine largeur de l'écran (pas de grille miniature) — le format portrait occupe naturellement une part importante de la hauteur d'écran mobile, cohérent avec l'usage principal du persona |
| **Navigation** | Swipe tactile horizontal comme interaction principale ; flèches cliquables en complément (utile aussi en version desktop) |
| **Boutons de téléchargement** | Empilés verticalement, pleine largeur, jamais côte à côte sur un écran étroit (au contraire d'un affichage desktop où ils peuvent être côte à côte) |
| **Lisibilité du texte dans l'image** | Garantie par le contrat typographique (§2.4-2.5) — vérifié pour un affichage mobile à ~360-390 px de large, c'est la condition de conception, pas un ajustement a posteriori |
| **Aucun défilement horizontal** | La page elle-même ne doit jamais déborder horizontalement (seul le swipe *au sein* du composant carrousel est horizontal) |

Aucune adaptation de contenu entre desktop et mobile (même image, même texte) — seule la mise en page de l'écran (disposition des boutons, taille du composant carrousel) s'adapte.

---

## 10. MVP scope (rendering + résultat)

**Requis** : structure de template unique 1080×1350 conforme à §2 ; typographie fixe (titre 64–72 px / corps 40–44 px) ; troncature de contenu (niveau LLM, déjà ratifiée) et troncature de rendu (niveau word-wrap, §4.4) ; export PNG × N + PDF × N pages au format 4:5, produits pendant le pipeline ; écran Résultat avec preview réelle, navigation, 2 boutons de téléchargement actifs, solde de crédits ; 3 messages d'erreur (analyse / mise en page / import du texte trop long, ce dernier bloqué en amont) ; comportement mobile pleinement fonctionnel (swipe, boutons empilés).

## 11. Out of scope

Choix de template · variante de gabarit par position de slide ou par longueur · auto-shrink de police · téléchargement d'une slide individuelle · édition du texte sur l'écran Résultat · partage direct depuis l'app · export dans un format additionnel (SVG, format d'impression A4) · adaptation de contenu spécifique au mobile · code d'erreur `EXPORT_ERROR` distinct (§8) · thème sombre/clair du template (le template a une seule palette, déjà tranchée ADR-006) · légendes/hashtags sur les slides.

---

## 12. Registre de décisions et alignement documentaire nécessaire

| ID | Sujet | Décision | Statut |
|---|---|---|---|
| **R-15** | Format des slides | **Portrait 1080×1350 (4:5)**, conforme à `GENERATION_SPEC.md`/`UX.md` (V1). Le carré 1080×1080 évoqué dans le brief M005 est écarté : le format 4:5 occupe davantage de hauteur de flux sur Instagram/LinkedIn, meilleure visibilité au scroll. | **Validé owner** |
| **R-16** | Taille de police exacte | Fourchettes retenues : titre 64–72 px, corps 40–44 px (§2.4). Une valeur unique à fixer par OpenCode dans ces bornes. | Défaut — OpenCode choisit, documente dans `DECISIONS.md` |
| **R-17** | Code d'erreur d'export | Pas de nouveau code ; `RENDER_ERROR` couvre PNG, PDF et ZIP côté utilisateur. | Défaut (§8) |
| **R-18** | PDF format A4 actuel | Non conforme — doit devenir 4:5 1080×1350, toutes les pages, pas seulement la première. | **Bloquant** pour la conformité de l'export |

### Alignement documentaire restant

Aucun réalignement de format n'est nécessaire : `GENERATION_SPEC.md` et `UX.md` étaient déjà corrects (1080×1350). Reste à faire : `docs/DECISIONS.md` (nouvel ADR pour la taille de police retenue, §12 R-16) · `AI_CONTRACT.md` (aucun changement requis — les bornes de caractères 60/220 restent valides pour 1080×1350, cf. §2.5).
