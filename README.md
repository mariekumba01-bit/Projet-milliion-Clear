# ClearMatch Benchmark — harnais de mesure v0.1

Banc d'essai **zéro-dépendance** (Node ≥ 23.6, test runner et TypeScript natifs — aucun
`npm install`) qui fait passer le moteur ClearMatch v0.1 de « codé » à **« testé et mesuré »**,
sans accès Pennylane (le blocage OAuth n'empêche pas la mesure : les données du terrain
ont été reconstituées en fixtures).

## Contexte produit

- ClearMatch AI : couche de **résolution des exceptions** de rapprochement facture↔paiement
  pour les utilisateurs de logiciels comptables (Pennylane d'abord) — jamais un clone du
  rapprochement natif.
- Terrain calé sur la réalité de la réforme : septembre 2026 en vigueur, première clôture
  mixte (exercices clos au 31/12/2026) en approche, obligation d'émission PME/TPE au
  1er septembre 2027.

## Ce que mesure le harnais

| Cohorte | Terrain | Contrat |
| --- | --- | --- |
| C1 (40) | natif Pennylane : référence lue + montant exact | **100 % résolu** — rater un rapprochement simple est disqualifiant |
| C2 (56) | v0.1 spécifié : partiels, écarts, devises, rejets, ambiguïtés, abstinence | zéro violation audit (un appariement faux = FAIL global) |
| C3 (18) | phase 2 : 17 cas **verrouillés** (groupés, ventilation, déductions, doublons) + 1 témoin déverrouillé | le moteur doit **s'abstenir** sur un verrou — jamais forcer |

Chaque résultat engine est comparé à une vérité terrain (décision, classe, facture visée,
résiduel au centime, note attendue, candidats attendus) :

- violations **audit** (appariement faux, classe erronée, forme incorrecte) → porte AUDIT échoue ;
- manques **mineurs** (note ou candidat absent) → dégradent la confiance, ne fabriquent pas de faux ;
- **abstention** là où une proposition était attendue → échec de résolution, direction sûre.

## Les 4 portes (toutes obligatoires)

1. **AUDIT** — zéro appariement faux ou forcé ;
2. **C1 exact** — 100 % du terrain natif résolu ;
3. **Discipline C3** — zéro proposition sur un cas verrouillé phase 2 ;
4. **Déterminisme** — 0 appel LLM par opération.

Le harnais est **prouvé capable d'échouer** : un moteur « négligent » (propose toujours la
première facture ouverte, confiance de façade 0,99) est éliminé sur les 4 portes et
cumule 113 appariements faux sur 114 (test `bench.test.ts`).

## Résultat de la passe de référence

```
Moteur : clearmatch-reference-v0.1
Cas : 114 — corrects 114, violations audit 0, mineurs 0
Précision : 100.0 % — Résolution : 100.0 %   (52 propositions attendues, 52 correctes)
Gates : AUDIT=PASS  C1=PASS  C3-discipline=PASS  LLM=PASS
Perf : médiane 0.6532 ms/op, ~1033 op/s
Coût : 3.27e-9 €/op  (plafonds kill de l'étude : 0,50 € immédiat / 0,10 € trajectoire — PASS/PASS)
```

## Utilisation

```bash
npm test        # 33 tests : moteur, dataset, harnais + témoin négatif
npm run bench   # exécute, mesure, écrit report/benchmark-report.{md,json} ; exit 1 si une porte échoue
```

Brancher le **vrai moteur ClearMatch** (à la place du moteur de référence) : éditer
`benchmark.config.json` → `"engine": "./chemin/vers/mon-moteur.ts"`. Le module doit
exporter `createEngine(config)` retournant `{ process(payment, openInvoices, context) }`
(contrat dans `src/types.ts`). Le moteur de référence (`src/engine.ts`) est une
réimplémentation fidèle de la spécification v0.1 — le benchmark est engine-agnostique.

## Arborescence

```
src/types.ts     — contrat engine + taxonomie 8 classes
src/engine.ts    — moteur de référence v0.1 (déterministe, requiresHuman, 0 LLM)
src/dataset.ts   — 114 paiements, vérité terrain complète (invariants auto-vérifiés à l'import)
src/bench.ts     — runner, scorer, métriques, rapports md/json (CLI)
src/adapter.ts   — chargeur de moteur (brancher le vrai moteur par config)
test/*.test.ts   — 33 tests, dont le témoin négatif « moteur négligent »
report/          — rapports de mesure générés
```

## Limites honnêtes

- Terrain **reconstitué** (fixtures réalistes, bruit réel : NBSP, minuscules, séparateurs) —
  pas encore des données de production ; le protocole Pennylane (OAuth partenaire + sandbox)
  reste le prochain palier de réalité.
- Le coût mesuré est le **calcul pur** ; le coût réel de traitement d'une opération inclura
  l'exploitation (hébergement, journal d'audit, isolation des entreprises) — à budgéter au
  forfait mensuel, pas à l'opération.
- Les prix d'abonnement restent des hypothèses de test ; ce harnais ne mesure pas la
  disposition à payer.
