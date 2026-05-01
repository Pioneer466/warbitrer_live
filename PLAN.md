# Plan De Correction Incidents Trading / UI / P&L

## Diagnostic Actuel

- Le `curl` de breaker global écrit bien `active:false`, mais l’UI peut encore afficher un breaker si un `slot:*` reste actif, si le `workerState` n’a pas encore été rafraîchi, ou si un nouvel incident réarme `global`.
  Commande de vérification immédiate :
  ```bash
  curl -fsS -u 'ethan:lechatestnoir' http://localhost:3000/api/circuit-breakers | jq '.[] | select(.active)'
  ```

- Le SOL `filled 6.09` pour `req 6.00` vient du mode Polymarket BUY en dollars : si le prix réel est meilleur que le prix limite, l’ordre achète plus de shares que prévu. C’est la cause directe du `overfilled by 0.085713`.

- Le BTC `invalid amount for a marketable BUY order ($0.65), min size: $1)` vient du même problème : Polymarket BUY en dollars impose un minimum de montant. Le code vérifie surtout la taille en shares, pas le montant minimum Polymarket.

- L’affichage `aligné` dans Trades doit être clarifié : `aligné` veut dire que les venues résolvent le même mouvement sous-jacent (`Polymarket UP` et `Kalshi YES`, ou `Polymarket DOWN` et `Kalshi NO`), pas que les deux jambes du pari gagnent.

- La perte inexpliquée de ~$6 doit être auditée à partir des snapshots de balances, settlements, fees, positions redeemable/mergeable et intents du créneau `2026-05-01 00:00-00:15`.

## Changements À Implémenter

- Breakers :
  - Ajouter une réponse UI/API plus explicite : `global`, `asset`, `slot`, `requiresManualClear`, `cooldownUntil`, `unresolvedIntentIds`.
  - Ajouter une commande/script `breaker:audit` qui affiche tous les breakers actifs et pourquoi ils restent actifs.
  - Après clear manuel, forcer l’UI à distinguer “global cleared” de “slot breaker still active”.

- Exécution Polymarket :
  - Séparer les modes BUY Polymarket :
    - hedge/incremental hedge/recovery : exact-size shares, jamais dollar-market flexible.
    - si exact-size CLOB n’est pas disponible, refuser le trade avant primaire plutôt que soumettre un BUY dollar qui peut overfill.
  - Ajouter une garde `maxHedgeOverfillShares = 0` pour les hedges : tout ordre Polymarket hedge doit être borné à la taille primaire restante.
  - Ajouter une garde minimum Polymarket market-buy amount : si le hedge restant coûte `< $1`, ne pas soumettre un marketable BUY dollar ; classer en `hold_to_settlement` ou `dust_unhedged` selon risque, pas unwind automatique.
  - En préflight primaire Kalshi, refuser toute entrée si le hedge Polymarket exact ne peut pas être exécuté proprement à la taille demandée.

- Rentabilité / sizing :
  - Ajouter des seuils configurables :
    - `minProjectedNetProfitUsd`
    - `minProjectedNetReturn`
    - `minWorstCaseProfitUsd`
  - L’éligibilité ne doit plus se baser seulement sur `grossCost <= threshold`; elle doit exiger un profit net après fees et slippage suffisamment large.
  - Telegram doit notifier le trade final `hedged`, pas le premier état `primary_filled`, pour éviter les notionnels tronqués.

- UI / Audit :
  - Page Portfolio : rendre les labels du graphe `P&L Global` plus gros, espacés, avec décimales visibles.
  - Page Trades : renommer `aligné` en `venues alignées` pour éviter l’ambiguïté.
  - Ajouter un audit créneau :
    ```bash
    npm run slot:audit -- --from "2026-05-01T00:00:00+02:00" --to "2026-05-01T00:15:00+02:00"
    ```
    Sortie attendue : intents, legs, fees, payouts, settlements, balance deltas, positions ouvertes/redeemable, P&L expliqué ligne par ligne.

## Tests À Ajouter

- Polymarket hedge BUY ne peut jamais remplir plus que la taille primaire restante.
- Un hedge Polymarket dont le coût est `< $1` ne déclenche pas d’unwind automatique de la primaire.
- Un overfill Polymarket est impossible en mode hedge exact-size.
- Les breakers affichent correctement global vs slot vs asset.
- `venues alignées` utilise bien `YES = UP` et `NO = DOWN`.
- Telegram envoie le notionnel final après `hedged`.
- Audit slot reconstruit correctement un créneau avec settled, unwound, failed, fees et positions reclaimables.

## Hypothèses

- On met la sécurité en priorité : tant que ces corrections ne sont pas déployées, il vaut mieux passer les assets en `shadow` ou `off`.
- La perte de ~$6 ne sera pas diagnostiquée par lecture des screenshots seuls ; il faut l’audit DB du créneau `00:00-00:15`.
- Le correctif principal est de supprimer le Polymarket BUY flexible en dollars pour les hedges, car c’est lui qui crée à la fois les overfills et les rejets `$1 min`.