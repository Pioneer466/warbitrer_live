# Plan: Vérité Effective Polymarket Et Retries Sûrs

## Summary
Le problème principal n’est pas seulement le sizing du BUY Polymarket: c’est que le bot a traité un hedge déjà effectivement rempli comme non rempli, puis a retry plusieurs fois, puis a lancé un unwind sur une lecture fausse de l’exposition.

On garde donc le multi-clipping/retry, mais uniquement après preuve forte que l’ordre précédent n’a pas rempli. Un ordre Polymarket `MATCHED`, `MINED`, `RETRYING` ou avec `size_matched > 0` doit compter comme exposition réelle, même si le trade n’est pas encore `CONFIRMED`.

## Key Changes
- Remplacer les patchs “single-submit” par un `PolymarketOrderTruth` central:
  - `effectiveFilledSize = max(order.size_matched, confirmedTrades + pendingTrades)`.
  - `confirmedFilledSize` reste séparé pour PnL/fills définitifs.
  - `MATCHED/MINED/RETRYING` comptent comme exposition, pas comme zéro fill.
  - `terminal_zero_fill` uniquement si order terminal + aucun trade pending/confirmed + `size_matched = 0`.

- Garder le BUY Polymarket en share-size:
  - `createAndPostMarketOrder` BUY utilise `amount` en USDC selon le SDK, donc ce n’est pas adapté à un hedge “10 shares”.
  - Utiliser un ordre limit `size` pour BUY Polymarket avec `FOK/FAK` conserve le comportement immédiat, mais plafonne la quantité.
  - SELL Polymarket reste en quantité de shares.

- Refaire le retry hedge autour de la vérité effective:
  - Avant chaque retry, resynchroniser tous les `venue_orders` de l’intent/leg.
  - Retry autorisé seulement si le dernier ordre est `terminal_zero_fill`.
  - Si fill partiel effectif: recalculer le reliquat et retry uniquement le reliquat.
  - Si vérité pending/unknown: rester en `hedging`/order `pending`, ne pas retry, laisser le reconciler terminer.

- Protéger l’unwind:
  - Avant tout unwind après hedge failure, refaire une sync vérité Polymarket.
  - Si hedge effectif >= primary: marquer `hedged`, aucun unwind.
  - Si hedge > primary: classer `overhedged`, ne pas unwind primary; tenter de vendre uniquement l’excès Polymarket sous slippage cap, sinon manuel.
  - Si hedge partiel: retry reliquat si possible, sinon recovery économique existante.

- Ajouter une review/audit destructive-fail:
  - Ajouter un script/commande d’audit d’un intent: orders, trades Polymarket, `size_matched`, pending/confirmed, fills DB, positions, exposition nette.
  - Ajouter événements runtime: `polymarket.order_truth.resolved`, `order.hedge.retry_allowed_zero_fill`, `order.hedge.retry_blocked_pending_truth`, `order.recovery.overhedged`.
  - Ne jamais downgrader une leg de filled nonzero vers zéro à cause d’une sync confirmed-only.

## Test Plan
- Polymarket truth:
  - `MATCHED` exact-size sans `CONFIRMED` => hedge effectif complet, aucun retry.
  - `size_matched = 10`, trades endpoint vide => hedge effectif complet/pending.
  - `canceled` + zéro trade + `size_matched = 0` => retry autorisé.
  - timeout/unknown => aucun retry, intent reste awaiting truth.

- Incident regression:
  - Trois BUY Polymarket successifs 10/11/12 shares sont agrégés à 33 shares.
  - Le bot classe `overhedged`, ne lance pas d’unwind primary.
  - Le bot tente uniquement la sortie de l’excès ou demande manuel.

- Execution/reconcile:
  - Multi-clipping reste actif après zéro fill prouvé.
  - Fill partiel effectif retry seulement le reliquat.
  - Reconcile pending -> confirmed ne change pas l’exposition, seulement la finalité/frais.
  - `npm run typecheck`, `npm test`, `git diff --check`.

## Assumptions
- On privilégie “attendre vérité” sur “retry rapide” pour Polymarket BUY.
- Les pending trades Polymarket sont traités comme exposition réelle côté risque.
- Le retry agressif reste acceptable pour Kalshi et pour Polymarket uniquement après zéro fill prouvé.
- Le patch local qui bloque tous les retries Polymarket doit être remplacé, pas conservé tel quel.



Plan validé et implémenté.

J’ai remplacé le patch “single-submit” par une vérité effective Polymarket centralisée dans src/lib/polymarket.ts (line 565): filledSize effectif = max(size_matched, trades confirmed + pending). Les statuts MATCHED, MINED, RETRYING et les trades pending comptent maintenant comme exposition réelle, donc le bot ne peut plus considérer “0 fill” alors qu’il a déjà acheté.

Changements clés :

BUY Polymarket reste en ordre limit exact-size, pas en montant USDC, dans src/lib/polymarket.ts (line 448).
Multi-clipping conservé, mais retry Polymarket BUY autorisé seulement après vérité terminalZeroFill, via src/lib/engine.ts (line 7482).
Avant tout unwind primaire, le moteur bloque si le hedge couvre déjà la primaire, et classe en intervention manuelle si overhedged, dans src/lib/engine.ts (line 5406).
Reconcile ne downgrade plus une exposition Polymarket effective vers une lecture confirmed-only.
Ajout d’un audit intent : npm run intent:audit -- --intent-id <id> via scripts/audit-intent.ts (line 22).
Tests ajoutés pour les cas MATCHED sans confirmation, trades pending, terminal zero-fill, retry Polymarket, et sizing BUY/SELL.

Vérifié :

npm run typecheck OK
npm test OK, 224 tests
git diff --check OK
Note : .gitignore et PLAN.md étaient déjà modifiés/non suivis dans le workspace; je ne les ai pas touchés.

6 files changed
+1083
-170
Undo

Review
package.json
audit-intent.ts
engine.ts
polymarket.ts
engine.test.ts
polymarket.test.ts
