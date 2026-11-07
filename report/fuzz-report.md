# ClearMatch Fuzz — rapport de mesure (moteur v0.2)

- **Moteur** : clearmatch-phase2-v0.2 — suite réaliste à grande échelle
- **Opérations** : 8461 (générées, seed 20261107 — reproductible)
- **Portefeuille** : 780 clients, 2099 factures ouvertes, 142 lots d'import (max 60/lot)
- **Résultat** : 8461 corrects, 0 faux

## Portes

| Porte | Critère | Verdict |
| --- | --- | --- |
| AUDIT | zéro faux appariement / zéro proposition interdite | ✅ PASS |
| RÉSOLUTION | ≥ 95 % des intentions résolubles proposées | ✅ PASS (6570/6570) |
| PERF médiane | ≤ 15 ms/op | ✅ PASS (6.4238 ms) |
| PERF p95 | ≤ 45 ms/op | ✅ PASS (9.4483 ms) |
| COÛT | ≤ 0.1 €/op (trajectoire kill) | ✅ PASS (3.21e-8 €) |

## Par intention

| Intention | n | corrects | problèmes (max 3 montrés) |
| --- | --- | --- | --- |
| exact | 3600 | 3600 | — |
| partial_ref | 900 | 900 | — |
| grouped_sum | 540 | 540 | — |
| grouped_ded | 270 | 270 | — |
| grouped_prorata | 270 | 270 | — |
| free_subset | 360 | 360 | — |
| ded2 | 360 | 360 | — |
| acompte | 270 | 270 | — |
| fee | 270 | 270 | — |
| usd | 180 | 180 | — |
| negatif | 270 | 270 | — |
| twin | 360 | 360 | — |
| piege | 181 | 181 | — |
| bare | 270 | 270 | — |
| no_match | 180 | 180 | — |
| dup_invoice | 180 | 180 | — |

## Hypothèses

- Médiane 6.4238 ms/op × 0.018 €/h de calcul (vCPU partagé) = 3.21e-8 €/op — moteur déterministe, 0 appel LLM.
- Le périmètre (2099 factures ouvertes) correspond à un grand tenant (grande entreprise ou cabinet en traitement groupé) ; le coût par lot reste négligeable devant toute tarification forfaitaire.
- Débit mesuré : 151 op/s.
