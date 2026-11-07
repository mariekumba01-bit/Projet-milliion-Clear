# Changelog

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
