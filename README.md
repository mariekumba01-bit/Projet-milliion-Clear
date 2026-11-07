# ClearMatch — bancs d'essai et moteurs (v0.1 + v0.2)

Banc d'essai **zéro-dépendance** (Node ≥ 23.6, test runner et TypeScript natifs) pour
**ClearMatch** : couche de **résolution des exceptions** de rapprochement facture↔paiement,
au-dessus du rapprochement natif de Pennylane — jamais un clone.

- **`src/engine.ts`** — moteur de référence **v0.1** : lecture exacte de références,
  partiels avec résiduel, écarts et devises, rejets, ambiguïtés, abstinence. Invariants :
  `requiresHuman = true`, `llmCalls = 0`, aucune écriture.
- **`src/engine-v02.ts`** — couche **phase 2 (v0.2)** par-dessus v0.1 : ventilations de
  virements groupés (somme exacte, escompte 2 %, prorata k/20 en arithmétique entière),
  déduction de 2 % reconnue (avec ou sans indice textuel), acomptes sans référence
  (facture ouverte unique), ventilation libre (combinaison unique), doublons de factures
  et de paiements (alertes, jamais d'affectation). Le v0.1 reste l'arbitre : si la
  résolution exacte n'existe pas, le v0.2 garde le verdict v0.1.
- **`src/fuzz.ts`** — suite de réalisme à grande échelle : ~8 500 opérations générées
  (PRNG semé, reproductible), bruit de saisie bancaire, pièges à fausses références,
  paires de jumeaux, doublons de factures ; 5 portes (audit, résolution, perf médiane
  et p95, coût).
- **`src/connector-pennylane.ts`** — traduction **fixtures → types de domaine**
  (zéro réseau) : chaque plateforme future est une autre traduction vers les mêmes
  types ; le moteur ne change jamais.

## Résultats (7 novembre 2026)

| Banc | Résultat | Portes |
| --- | --- | --- |
| Benchmark 114 cas (C1 natif / C2 v0.1 / C3 phase 2) | 114/114, 0 violation audit | AUDIT, C1, discipline C3, LLM : PASS |
| Phase 2 sur C3 (18 cas : 17 verrous + 1 témoin) | 18/18 résolus, ventilations au centime | voir `test/engine-v02.test.ts` |
| Non-régression C1+C2 (96 cas) | v0.2 = v0.1 partout (décision, classe, proposition, notes, candidats) | idem |
| Fuzz 8 461 opérations, 2 099 factures, 144 lots | 0 faux appariement, 6 570/6 570 résolus (100 %) | AUDIT, RÉSOLUTION, PERF (méd. 6,42 ms, p95 9,45 ms), COÛT (3,21e-8 €/op) : PASS |
| Tests automatisés | 68/68 | moteurs, dataset, harnais (dont témoin négatif), connecteurs, persistance |

Le harnais est **prouvé capable d'échouer** : un moteur « négligent » (propose toujours
la première facture ouverte) est éliminé sur les 4 portes du benchmark, et la moindre
affectation approximative fait tomber la porte d'audit du fuzz.

## Utilisation

```bash
npm install          # devDependencies uniquement (typescript, @types/node)
npm test             # 68 tests : v0.1, dataset, harnais, v0.2, connecteurs, persistance
npm run bench        # benchmark 114 cas → report/benchmark-report.{md,json}
npm run fuzz         # suite de réalisme → report/fuzz-report.{md,json}
npm run typecheck    # tsc --noEmit
```

Variantes du fuzz : `npm run fuzz -- --ops=12000 --seed=42`.

Brancher un autre moteur : `benchmark.config.json` → `"engine"` (le module doit exporter
`createEngine(config)` → `{ process(payment, openInvoices, context) }`, contrat dans
`src/types.ts`). Le harnais est engine-agnostique.

## Arborescence

```
src/types.ts                 — contrat partagé, taxonomie 8 classes, breakdown (ventilation)
src/engine.ts                — moteur de référence v0.1 (déterministe, requiresHuman, 0 LLM)
src/engine-v02.ts            — couche phase 2 v0.2 (P1–P6, ventilations au centime)
src/phase2.ts                — vérité terrain v0.2 des 18 cas C3 (expressive, relative au contenu)
src/dataset.ts               — 114 paiements, vérité terrain complète, invariants auto-vérifiés
src/bench.ts                 — runner, scorer, métriques, rapports (CLI)
src/fuzz.ts                  — suite de réalisme à grande échelle (générateur déterministe)
src/connector-pennylane.ts   — traduction Pennylane → domaine (fixtures, zéro réseau)
src/connector-saspay.ts      — encaissement SasPay : liens, webhooks signés (HMAC + âge),
                                montants charged/net_amount, paliers FCFA, plan mensuel
src/store.ts                 — persistance fichier : journal d'audit chaîné par hachage,
                                snapshots atomiques (aucune base de données)
src/adapter.ts               — chargeur de moteur (config)
test/*.test.ts               — 68 tests, dont témoins négatifs
report/                      — rapports de mesure générés (benchmark, fuzz)
scripts/                     — utilitaires de débogage (debug-piege.ts)
```

## Limites honnêtes

- Terrain **reconstitué** (fixtures réalistes, bruit réel) — pas des données de
  production ; c'est le rôle des pilotes cabinets de corriger cela.
- Le connecteur couvre la **traduction** ; l'ingestion réseau (OAuth partenaire,
  webhooks, sandbox) dépend des accès accordés par le programme partenaire.
- Le coût mesuré est le calcul pur ; l'exploitation réelle se budgète au forfait mensuel.
- Les prix d'abonnement (49/149/399 €/mois) restent des hypothèses de test.
- L'API SasPay v1.0.0 n'a pas de prélèvement récurrent natif : la facturation suit
  le modèle « lien de paiement par mois » (src/connector-saspay.ts). SasPay est un
  service très jeune : vérifier les mentions légales et le statut d'établissement de
  paiement lors de l'inscription (KYC) avant tout basculement en clé sk_live_.
- La persistance fichier couvre un seul poste écrivain par pilote ; la concurrence
  multi-tenants est le moment de parler de SQLite (toujours sans serveur), jamais avant.

## Conventions de code

- Montants en **centimes entiers**, jamais de flottants (prorata : `round(cents × k/20)`) ;
  côté SasPay, rapprocher sur `charged` et `net_amount`, jamais sur le montant demandé seul.
- `requiresHuman = true` et `llmCalls = 0` sur tout résultat — invariants testés.
- Les webhooks entrants : signature HMAC-SHA256 sur le corps brut + contrôle d'âge
  (5 minutes) — deux contrôles, jamais un seul.
- Toute nouvelle capacité moteur passe par le même circuit : vérité terrain d'abord,
  puis implémentation, puis non-régression, puis fuzz — jamais l'inverse.
