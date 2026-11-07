# ClearMatch Benchmark — rapport de mesure

- **Moteur** : clearmatch-reference-v0.1
- **Cas** : 114 (C1 natif / C2 v0.1 / C3 phase 2 verrouillée)
- **Résultat** : 114 corrects, 0 violations audit, 0 manques mineurs

## Portes de validation (gates)

| Porte | Critère | Verdict |
| --- | --- | --- |
| AUDIT | zéro appariement faux ou forcé | ✅ PASS |
| C1 — terrain natif | 100 % de rapprochements simples réussis | ✅ PASS |
| C3 — discipline | zéro proposition sur un cas verrouillé phase 2 | ✅ PASS |
| Coût déterministe | 0 appel LLM par opération | ✅ PASS |

## Résolution et précision

- Précision des propositions : **100.0 %** (52/52)
- Taux de résolution (propositions attendues et correctes) : **100.0 %** (52/52)
- Complétude des preuves (≥ 2 preuves + explication) : 100.0 %

## Par cohorte

| Cohorte | n | corrects | violations audit | manques mineurs |
| --- | --- | --- | --- | --- |
| C1 | 40 | 40 | 0 | 0 |
| C2 | 56 | 56 | 0 | 0 |
| C3 | 18 | 18 | 0 | 0 |

## Matrice de confusion (lignes = attendu, colonnes = prédit)

| attendu \ prédit | matched_exact | matched_partial | amount_mismatch | currency_mismatch | rejected_or_reversal | ambiguous | unmatched_no_candidate | multi_reference_grouped |
| --- |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |  ---  |
| **matched_exact** | 41 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| **matched_partial** | 0 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| **amount_mismatch** | 0 | 0 | 10 | 0 | 0 | 0 | 0 | 0 |
| **currency_mismatch** | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |
| **rejected_or_reversal** | 0 | 0 | 0 | 0 | 8 | 0 | 0 | 0 |
| **ambiguous** | 0 | 0 | 0 | 0 | 0 | 14 | 0 | 0 |
| **unmatched_no_candidate** | 0 | 0 | 0 | 0 | 0 | 0 | 18 | 0 |
| **multi_reference_grouped** | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 8 |

## Bandes de confiance des propositions

| Bande | correctes | fausses |
| --- | --- | --- |
| ≥ 0,95 | 34 | 0 |
| 0,85–0,95 | 17 | 0 |
| < 0,85 | 1 | 0 |

## Performance et coût (critères kill de l'étude)

- Médiane : 0.2342 ms/op — p95 : 0.4735 ms/op — débit : 2175 op/s
- Coût calcul : **1.17e-9 €/opération** (plafond immédiat : 0.5 € — PASS ; trajectoire : 0.1 € — PASS)
- Hypothèse : médiane 0.2342 ms/op × 0.018 €/h de calcul (vCPU partagé) — moteur déterministe, 0 appel LLM
- Appels LLM : 0 (le seul risque réaliste de dépasser 0,10 €/op est d'ajouter des appels LLM par opération — à budgéter par exception, jamais par opération).

## Backlog phase 2 (réservé au moteur avancé)

- **ventilation groupée** — 8 cas verrouillés — v0.1 doit s'abstenir : case-097, case-098, case-099, case-100, case-101, case-102, case-103, case-104
- **ventilation libre (somme de 2 factures sur 3)** — 1 cas verrouillés — v0.1 doit s'abstenir : case-105
- **paiement partiel sans référence** — 2 cas verrouillés — v0.1 doit s'abstenir : case-106, case-107
- **déduction justifiée (escompte 2 %)** — 1 cas verrouillés — v0.1 doit s'abstenir : case-108
- **déduction justifiée (remise 2 %)** — 1 cas verrouillés — v0.1 doit s'abstenir : case-109
- **déduction sans indice lisible (écart = 2 % exactement)** — 1 cas dont 1 témoin déverrouillé, résolu en v0.1 comme paiement partiel (phase 2 doit reconnaître la déduction) : case-110
- **détection de doublons (factures)** — 2 cas verrouillés — v0.1 doit s'abstenir : case-111, case-112
- **détection de doublons (paiements)** — 2 cas verrouillés — v0.1 doit s'abstenir : case-113, case-114
