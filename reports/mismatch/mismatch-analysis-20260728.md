# Analyse historique des mismatches — 28 juillet 2026

## Résultat

La fenêtre principale est figée du **25 juillet 2026 16:30 UTC** au **28 juillet 2026 16:30 UTC**, soit exactement 288 créneaux de 15 minutes par actif.

- Postgres contenait 243 créneaux finalisés par actif.
- La coupure du 28 juillet avait supprimé 45 créneaux par actif.
- Les 45 créneaux manquants ont été récupérés via les API officielles Polymarket et Kalshi.
- Le créneau 10:45 UTC, présent dans les deux sources, a servi de contrôle : 7 concordances sur 7 actifs.
- Les 322 lignes récupérées pour contrôler la plage entière de coupure sont toutes finalisées des deux côtés, avec zéro conflit entre résultat et benchmark terminal.
- Après déduplication : 288 créneaux complets par actif, 2 016 résolutions au total.

Les résolutions récupérées sont conservées dans les artefacts d’analyse. Elles n’ont pas été injectées dans Postgres : les résolutions officielles sont reconstructibles, mais pas les ticks Chainlink/CF qui n’ont jamais été observés pendant la coupure.

## Taux observés sur les 72 heures complétées

| Actif | Mismatches | Taux | IC Wilson 95 % | Poly DOWN / Kalshi YES | Poly UP / Kalshi NO |
|---|---:|---:|---:|---:|---:|
| BTC | 17 / 288 | 5,90 % | 3,72–9,25 % | 10 | 7 |
| ETH | 10 / 288 | 3,47 % | 1,90–6,27 % | 5 | 5 |
| SOL | 22 / 288 | 7,64 % | 5,10–11,29 % | 10 | 12 |
| XRP | 23 / 288 | 7,99 % | 5,38–11,70 % | 13 | 10 |
| DOGE | 31 / 288 | 10,76 % | 7,69–14,87 % | 13 | 18 |
| BNB | 24 / 288 | 8,33 % | 5,66–12,10 % | 11 | 13 |
| HYPE | 19 / 288 | 6,60 % | 4,26–10,07 % | 11 | 8 |

Total : **146 mismatches sur 2 016 résolutions, soit 7,24 %**.

Les deux directions sont exactement équilibrées sur cette fenêtre : 73 cas `Poly DOWN / Kalshi YES` et 73 cas `Poly UP / Kalshi NO`. Il n’y a donc pas de biais directionnel global visible.

## Comparaison avec l’historique plus long

La fenêtre commune à tous les actifs va du **23 juillet 14:15 UTC** au **28 juillet 16:30 UTC**. Après récupération de la coupure, elle contient 489 créneaux complets par actif :

| Actif | Taux sur 489 créneaux | Historique retenu complet |
|---|---:|---:|
| BTC | 6,13 % | 6,12 % sur 1 111 |
| ETH | 6,13 % | 6,04 % sur 1 110 |
| SOL | 6,54 % | 7,02 % sur 1 111 |
| XRP | 9,20 % | 7,29 % sur 1 111 |
| DOGE | 9,82 % | 7,92 % sur 1 111 |
| BNB | 9,20 % | 9,20 % sur 489 |
| HYPE | 6,13 % | 6,13 % sur 489 |

Les niveaux récents sont globalement cohérents avec l’historique disponible. DOGE monte de 6,93 % sur sa période antérieure à 10,76 % récemment, tandis qu’ETH baisse de 6,93 % à 3,47 %. Les intervalles restent larges et ces écarts ne suffisent pas, avec sept comparaisons simultanées, à conclure à un changement de régime propre à un actif.

BNB est structurellement parmi les taux les plus élevés dans cet échantillon. HYPE n’est pas anormalement élevé par rapport à BTC/ETH/SOL.

## Regroupement temporel

Sur les 288 créneaux :

- 188 n’ont aucun mismatch ;
- 62 en ont un seul ;
- 31 en ont deux ;
- 6 en ont trois ;
- 1 en a quatre, le 26 juillet à 01:30 UTC sur BNB, DOGE, HYPE et XRP.

À taux marginaux identiques mais en supposant les actifs indépendants, on attendrait environ 170 créneaux sans mismatch, 93 avec un, 22 avec deux, 2,8 avec trois et 0,2 avec quatre. La variance observée du nombre de mismatches simultanés est **1,35 fois** la variance indépendante.

Les événements sont donc regroupés par régimes : davantage de créneaux totalement calmes, mais aussi davantage de mismatches multi-actifs. Les corrélations paire à paire restent modestes ; la plus forte est BTC/DOGE à environ 0,20. Cela correspond davantage à un effet commun de volatilité et de différence de méthode/timing entre benchmarks qu’à un flux cassé sur un actif isolé.

## Qualité du modèle selon le temps restant

Pour chaque créneau déjà observé par le runtime, l’analyse prend la dernière observation persistée avant 5 min, 3 min, 2 min, 1 min et 30 s de la fin, dans une tolérance maximale de 20 s. La probabilité de mismatch est la somme des deux probabilités directionnelles fatales.

| Temps restant | Observations modèle | Taux réel | Probabilité moyenne | Brier ↓ | AUC ↑ | Rappel dans les 10 % les plus risqués |
|---|---:|---:|---:|---:|---:|---:|
| 5 min | 1 628 | 7,06 % | 16,96 % | 0,0851 | 0,755 | 27,0 % |
| 3 min | 1 628 | 7,06 % | 11,83 % | 0,0735 | 0,796 | 28,7 % |
| 2 min | 1 629 | 7,06 % | 10,27 % | 0,0691 | 0,823 | 30,4 % |
| 1 min | 1 625 | 7,02 % | 7,82 % | 0,0580 | 0,877 | 49,1 % |
| 30 s | 1 629 | 7,06 % | 5,60 % | 0,0416 | 0,912 | 65,2 % |

Conclusion sur le cutoff : passer de 3 minutes à 1 minute est soutenu par les données. À 1 minute, le modèle discrimine beaucoup mieux les futurs mismatches, avec une calibration moyenne proche du taux réel. À 30 secondes, la discrimination progresse encore, mais le modèle sous-estime déjà le taux absolu et produit quelques erreurs très confiantes : la log-loss diagnostique passe de 0,250 à 2 minutes à 0,258 à 1 minute puis 0,275 à 30 secondes.

Il faut donc conserver le statut **uncalibrated** et le mode shadow. Ces résultats ne justifient pas encore d’utiliser directement la probabilité brute comme autorisation d’exécution.

Sur le sous-ensemble strictement utilisable pour l’exécution, les résultats restent bons à 1 minute : AUC 0,874, Brier 0,0572, taux réel 6,57 % et probabilité moyenne 7,43 %.

## BNB, HYPE et qualité des flux

À 1 minute :

- BNB : 218 estimations disponibles sur 243 créneaux observés, AUC 0,845 ;
- HYPE : 216 sur 243, AUC 0,849.

Les 21 `chainlink_unavailable` de chacun sont tous antérieurs à la correction du flux, du 25 juillet 16:30 à 21:30 UTC. Aucun nouveau `chainlink_unavailable` BNB/HYPE n’apparaît après cette plage dans l’échantillon.

Les deux `final_minute_average_unavailable` de HYPE ne sont pas des coupures durables. Ils se produisent exactement à la frontière des 60 secondes, avant le premier échantillon CF de la minute finale ; le modèle redevient disponible 2 à 3 secondes plus tard et la fenêtre atteint ensuite 58–59 observations.

Un point distinct demeure : à 1 minute, 376 des 1 625 estimations diagnostiques disponibles ne satisfont pas la fraîcheur stricte d’exécution, toutes avec `chainlink_stale`. Cela ne doit pas conduire à détendre la barrière de sécurité. Il faut plutôt mesurer séparément la cadence Chainlink et la distribution d’âge au moment exact où une opportunité serait admissible.

## Décisions recommandées

1. Conserver le cutoff d’entrée à 60 secondes.
2. Garder le modèle mismatch en shadow et marqué `uncalibrated`.
3. Accumuler au moins deux à quatre semaines supplémentaires, puis calibrer hors échantillon par horizon et, si le volume le permet, par actif.
4. Ajouter un backfill automatique des seules résolutions officielles après une coupure, avec provenance et contrôle de conflit ; ne jamais fabriquer les observations de flux manquantes.
5. Instrumenter la fraîcheur stricte Chainlink au moment des opportunités réellement éligibles avant de modifier un seuil.

## Artefacts

- `mismatch-resolutions-72h.csv` : jeu final de 2 016 résolutions, dédupliqué et complet.
- `official-gap-20260728T0500Z-1630Z.json` : récupération officielle brute de la plage de coupure.
- `db-resolutions-retained.csv` : historique des résolutions retenues en production.
- `model-horizons-20260725T1630Z-20260728T1630Z.csv` : observations du modèle aux cinq horizons.
- `mismatch-analysis-summary.json` : métriques détaillées et reproductibles.
- `scripts/fetch-official-mismatch-history.mjs` : récupération officielle en lecture seule.
- `scripts/analyze-mismatch-history.mjs` : jointure, validation et calcul des métriques.

Empreintes SHA-256 principales :

- récupération officielle : `832f972b418f51217303835a8b3d2e75710a9e1c28e68fa317daf7bc623c01cc`
- jeu 72 h final : `ac057db8a261a4b5d75005e9dc8fac5c0d84de01d6ed008b01b9acbe1e731409`
