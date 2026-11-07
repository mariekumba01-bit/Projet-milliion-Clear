# Changelog

## v0.2.1 — 7 novembre 2026 (suite)

### Ajouté

- **`src/store.ts`** : persistance fichier, zéro dépendance, zéro base de données.
  - `AuditJournal` : journal append-only (JSONL) **chaîné par hachage** — chaque entrée
    scelle le hachage de la précédente ; toute falsification ou retrait rétroactif est
    détecté au prochain `verify()` (testé : modification d'une entrée, suppression,
    réordonnancement), et l'écriture refuse de continuer sur une chaîne cassée.
  - Tolérance aux crashs : dernière ligne tronquée ignorée, snapshots écrits
    atomiquement (tmp + rename), snapshot illisible → null (ré-importer, jamais deviner).
- **`src/connector-saspay.ts`** : encaissement SasPay, couche pure sans réseau,
  fidèle à la spécification vérifiée (docs.saspay.me, OpenAPI v1.0.0, 37 routes).
  - `buildLinkRequest` : validation croisée `amount_type`/`amount` que l'API délègue
    à l'intégrateur (FIXED sans montant rejeté, FREE avec montant rejeté).
  - `verifyWebhookSignature` : HMAC-SHA256 sur `{timestamp}.{corps brut}` + contrôle
    d'âge 5 min — les deux contrôles de la doc, testés contre falsifications.
  - `reconcileAmounts` : ADD_ON / DEDUCTED — rapprocher sur `charged` et `net_amount`.
  - `tierToFcfa` : 49/149/399 € → 32 000 / 97 500 / 261 500 FCFA (parité fixe
    655,957, arrondi au 500 FCFA).
  - `monthlyLinkPlan` : plan « lien par mois » (l'API v1.0.0 n'a pas de récurrent
    natif) — envoi J1, rappel J7, suspension J21.
- `test/store.test.ts` (6 tests) et `test/connector-saspay.test.ts` (13 tests).
- Tableau de bord : équivalents FCFA par palier + note d'encaissement SasPay.

### Modifié

- Kit de lancement (.docx/.pdf) : Stripe remplacé par SasPay partout — section 6
  réécrite (frais relevés, parité FCFA, plan mensuel, checklist 6 étapes, webhooks
  HMAC), calendrier S10-S13, annexe enrichie (3 liens saspay), 13 pages.
- `package.json` : 0.2.1 ; suite de tests élargie (68).

### Décisions d'infrastructure (réponses aux questions « Supabase ? Render ? domaine ? »)

- **Aucune base de données** : `src/store.ts` suffit pour toute la vie des pilotes
  (journal d'audit chaîné + snapshots atomiques). Migration prévue, dans l'ordre :
  SQLite (sans serveur) puis base managée — uniquement si une limite mesurée mord.
- **Aucun hébergeur** : le moteur tourne en local (Node ≥ 23.6, zéro dépendance) ;
  le tableau de bord est un fichier HTML autonome partagé tel quel. Branche
  `gh-pages` du dépôt prête (index.html seul) pour une URL gratuite le jour où la
  visibilité du dépôt le permettra — jamais nécessaire avant.
- **Aucun nom de domaine** : `username.github.io` est offert le jour voulu ; un
  domaine dédié est un choix de marque, pas un besoin.

### Mesures de la version

- Tests : 68/68. Typecheck : sans erreur.
- Benchmark et fuzz inchangés (aucune modification des moteurs) : 114/114 et 0 faux
  sur 8 461 opérations.

## v0.2.0 — 7 novembre 2026

### Ajouté

- **`src/engine-v02.ts`** : couche phase 2 par-dessus le moteur de référence v0.1.
  - P1 — ventilation des virements groupés : somme exacte, escompte 2 % sur le groupe,
    prorata k/20 (grille 5–95 %) en **arithmétique entière** (`round(cents × k/20)`),
    ventilation détaillée `breakdown` (une ligne par facture, affecté + reste à recevoir).
  - P2 — déduction de 2 % reconnue sur facture unique (avec ou sans indice textuel
    ESCOMPTE/REMISE) ; le témoin `case-110` passe de « paiement partiel » à « déduction
    reconnue », résiduel nul.
  - P3 — acompte sans référence : uniquement si facture ouverte unique + « ACOMPTE » lu.
  - P4 — ventilation libre : seule combinaison de factures ouvertes sommant au montant
    (combinaisons multiples → ambiguïté, jamais d'affectation).
  - P5/P6 — doublons de factures confirmés et doublons de paiements probables
    (jumeau dans le lot d'import, ± 3 jours) : alertes documentées, aucune affectation.
- **`src/phase2.ts`** : vérité terrain v0.2 de la cohorte C3 (18 cas), expressive et
  relative au contenu (aucun identifiant ni montant codé en dur) + contrôle de
  couverture (18/18, zéro spécification fantôme).
- **`src/fuzz.ts`** : suite de réalisme à grande échelle — générateur déterministe
  (PRNG semé), 16 intentions calibrées, bruit de saisie bancaire, pièges à fausses
  références validés contre `findRefHits` (sémantique exacte du moteur) **au moment
  du jugement** (le monde grandit pendant la génération), paires de jumeaux et
  doublons de factures dans le même lot d'import ; 5 portes (audit, résolution ≥ 95 %,
  perf médiane ≤ 15 ms, p95 ≤ 45 ms, coût ≤ 0,10 €/op) ; rapports md/json.
- **`src/connector-pennylane.ts`** : traduction fixtures Pennylane → types de domaine,
  zéro réseau. Factures fermées et devises non supportées écartées avec avertissement,
  jamais de conversion implicite. Le moteur, le harnais et le fuzz restent
  plateforme-agnostiques (l'indépendance multi-plateformes est architecturale).
- `test/engine-v02.test.ts` (résolution C3 18/18, non-régression stricte C1+C2 sur 96
  cas, négatifs ad hoc : jamais de forçage) et `test/connector.test.ts` (traduction +
  bout en bout + invariants) : **50 tests au total**.
- `scripts/debug-piege.ts` : reproduction instrumentée du défaut « piège validé puis
  invalidé par la croissance du monde » (conservé comme trace du correctif).

### Modifié

- `src/engine.ts` : export des helpers partagés (`norm`, `findRefHits`, `detectCustomer`,
  `fmtEur`, `dayDiff`) + **caches de compilation des regex** (factures et clients) —
  aucune sémantique modifiée ; latence médiane du fuzz 15,66 → 6,42 ms/op (×2,4).
- `src/types.ts` : `Proposal.breakdown?` (ventilation), `EngineContext.batchPayments?`
  (lot d'import pour la détection de jumeaux) — tous deux optionnels et ignorés par
  le v0.1 (non-régression garantie par contrat).
- `package.json` : 0.2.0, scripts `fuzz`, suite de tests élargie.

### Corrigé (fuzz, itérations mesurées)

- Prorata : les littéraux flottants (0,05…0,95) divergeaient d'un centime des produits
  `k × (1/20)` → moteur **et** générateur partagent désormais l'arithmétique entière
  k/20 (la divergence était côté générateur, le moteur avait raison sur la somme).
- Pièges : le garde-fou testait l'égalité exacte des numéros au lieu de la sémantique
  du moteur (variantes de motifs) ; la transposition portait sur le numéro complet
  (année comprise) → désormais limitée à la partie propre, et validée avec
  `findRefHits` contre le monde **final** (voir « Ajouté »).
- Perf : cache de compilation (voir « Modifié »).

### Mesures de la version

- Benchmark 114 cas : 114/114, 4 portes PASS.
- Fuzz 8 461 opérations (2 099 factures ouvertes, 144 lots, 780 clients) :
  0 faux appariement, résolution 6 570/6 570 (100 %), médiane 6,42 ms/op,
  p95 9,45 ms, 3,21 × 10⁻⁸ €/op, 0 appel LLM.
- Tests : 50/50. Typecheck : sans erreur.

## v0.1.0 — 6 novembre 2026

Version initiale : moteur de référence, dataset 114 cas, harnais de mesure,
rapporteur md/json, 33 tests dont le témoin négatif « moteur négligent ».
