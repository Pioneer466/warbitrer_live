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


RÉSUMÉ PROBLÉMATIQUE PRÉCÉDENTE :
énorme prolbème :
BTC · POLY_DOWN_KALSHI_YES · unwound
30 avr. 2026, 16:16
kalshi -> polymarket · notionnel 25,40 $US
polymarket · DOWN
investi 22,20 $US · req 10.00 · filled 33.05 · fee 0,00 $US
kalshi · YES
investi 3,20 $US · req 10.00 · filled 10.00 · fee 0,00 $US
Notionnel réduit par safeguard mismatch (medium): taille x0.5
Incremental hedge order not filled (order couldn't be fully filled. FOK orders are fully filled or killed.); primary unwound

Je ne sais pas où est parti l'argent

Show less
4:19 PM


Worked for 3m 54s
Oui, là le problème est identifié: les 33.05 DOWN ne sont pas “disparus”, ils ont été achetés sur Polymarket. Les 3 lignes Polymarket Bought 10 + 11 + 12 Down correspondent exactement au filled 33.05.

Cause probable corrigée dans le code: les BUY Polymarket étaient envoyés comme market orders en montant USDC. Donc si on envoyait environ $7.40, Polymarket pouvait acheter 10, 11, puis 12 shares selon le prix disponible. J’ai corrigé ça: les BUY Polymarket passent maintenant en limit order par taille exacte, donc size=10 veut dire acheter 10 shares max, pas dépenser $7.40.

Vérifs passées :

npm run typecheck OK
npm test OK, 218 tests
À faire maintenant sur le VPS, d’abord stop pour éviter un autre cas :

cd /opt/warbitrer-live/app
sudo systemctl stop warbitrer-asset@btc warbitrer-asset@eth warbitrer-asset@sol warbitrer-asset@xrp warbitrer-asset@doge warbitrer-worker
Puis inspecte l’intent BTC :

set -a; source .env; set +a

psql "$DATABASE_URL" -c "
select id,status,slot_key,to_timestamp(created_at/1000.0) as created_at,
primary_venue,hedge_venue,target_notional_usd,failure_reason,legs_json
from order_intents
where slot_key like 'btc:%'
order by created_at desc
limit 5;
"
Avec l’id de l’intent :

psql "$DATABASE_URL" -c "
select venue,venue_order_id,side,outcome,order_type,requested_price,requested_size,
filled_size,average_fill_price,status,to_timestamp(created_at/1000.0) as created_at
from venue_orders
where intent_id = 'PASTE_INTENT_ID'
order by created_at;
"

psql "$DATABASE_URL" -c "
select venue,side,outcome,price,size,price*size as notional,trade_id,
to_timestamp(filled_at/1000.0) as filled_at
from fills
where intent_id = 'PASTE_INTENT_ID'
order by filled_at;
"
Et positions Polymarket vues par le bot :

npx tsx -e 'import { createPolymarketAdapter } from "./src/lib/polymarket"; createPolymarketAdapter().getPositions().then(x => console.log(JSON.stringify(x.filter(p => p.asset==="btc"), null, 2))).catch(e => { console.error(e); process.exit(1); });'
Si ça affiche une position BTC DOWN d’environ 33, l’argent est là sous forme de shares, pas en cash. Le fait que tu ne puisses pas vendre dans l’UI Polymarket peut venir d’un délai de sync/settlement côté Polymarket, mais côté bot on doit le voir dans positions/fills.

2 files changed
+31
-15
Undo

Review
engine.ts
polymarket.ts




4:23 PM
je ne sais pas, sur le VPS, il en parle comme étant mis, sur polymarket il me dit que c'est acheté mais je ne peux aps vendre, tu aurais une raison ?
4:24 PM


Worked for 25s
Oui, j’ai une raison probable.

Les lignes Polymarket disent que tu as acheté :

10 Down à 0.71
11 Down à 0.68
12 Down à 0.63
Total ≈ 33 shares DOWN, ce qui correspond au filled 33.05 affiché par le bot. Donc l’argent est probablement dans une position Polymarket DOWN, pas en cash disponible.

Pourquoi tu ne peux pas vendre :

Trade encore pending/indexation lente : Polymarket affiche “Bought”, mais le token conditional n’est pas encore sellable côté CLOB.
Allowance conditional token pas à jour : tu as les shares, mais le CLOB ne voit pas encore l’autorisation de vente.
Marché proche/fin de slot : orderbook fermé ou illiquide, donc l’UI ne propose pas vraiment de sortie.
Bug qu’on vient de corriger : le bot a envoyé des BUY Polymarket en montant USDC, donc il a acheté plus de shares que prévu. J’ai corrigé pour que ça achète maintenant une taille exacte.
Sur le VPS, checke précisément :

cd /opt/warbitrer-live/app
set -a; source .env; set +a
Dernier intent BTC :

psql "$DATABASE_URL" -c "
select id,status,slot_key,to_timestamp(created_at/1000.0) created_at,failure_reason,legs_json
from order_intents
where slot_key like 'btc:%'
order by created_at desc
limit 3;
"
Récupère le tokenId Polymarket DOWN :

psql "$DATABASE_URL" -c "
select id, leg->>'venue' venue, leg->>'outcome' outcome, leg->>'tokenId' token_id,
leg->>'filledSize' filled_size, leg->>'filledPrice' filled_price
from order_intents, jsonb_array_elements(legs_json) leg
where id = 'PASTE_INTENT_ID';
"
Puis vérifie si les shares sont sellable :

npx tsx -e 'import { getPolymarketConditionalSellableBalance } from "./src/lib/polymarket"; getPolymarketConditionalSellableBalance(process.argv[1]).then(x => console.log(JSON.stringify(x,null,2))).catch(e => { console.error(e); process.exit(1); });' "PASTE_TOKEN_ID"
Interprétation :

balance ≈ 33 et sellable ≈ 0 : tu as les shares, mais elles ne sont pas encore vendables/allowance pas prête.
balance ≈ 33 et sellable ≈ 33 : elles sont vendables côté CLOB, l’UI Polymarket bug ou manque de liquidité.
balance ≈ 0 mais Polymarket affiche l’achat : probablement trade encore pending/indexation ou mismatch wallet/proxy.
Et stoppe les workers tant que le patch n’est pas déployé :

sudo systemctl stop warbitrer-asset@btc warbitrer-asset@eth warbitrer-asset@sol warbitrer-asset@xrp warbitrer-asset@doge warbitrer-worker




4:25 PM
ok c'est bon. MAINTENANT JE VEUX QUE TU ME RÈGLES ÇA A TOUT JAMAIS ET POUR DE BON ,C'ÉTAIT ULTRA DANGEREUX !
4:29 PM


Worked for 7m 43s
J’ai corrigé la cause dangereuse.

Le bug venait de src/lib/polymarket.ts (line 374): les BUY Polymarket passaient par createAndPostMarketOrder avec amount = maxCostUsd. Donc pour “acheter 10 shares”, le bot pouvait en réalité “dépenser ~$7.40”, ce qui explique tes 10 + 11 + 12 DOWN achetés.

Maintenant:

BUY Polymarket = ordre limit exact-size avec size: order.size, jamais amount USDC.
SELL Polymarket garde amount: shares, ce qui est correct pour vendre.
Confirmation Polymarket exige la taille exacte demandée.
Un hedge incremental partiel ne peut plus être classé comme hedged.
Si un hedge dépasse la taille attendue, le bot bloque en manuel au lieu de faire une sortie automatique dangereuse sur la mauvaise jambe.
Tests ajoutés pour empêcher une régression de ce bug.
Fichiers modifiés:

src/lib/polymarket.ts (line 430)
src/lib/engine.ts (line 2697)
tests/polymarket.test.ts (line 32)
tests/engine.test.ts (line 813)
Vérifié:

npm run typecheck OK
npm test OK, 220 tests
git diff --check OK
Important: ne relance pas le live sans déployer ce patch. L’argent de l’incident n’a probablement pas “disparu”: il est en shares Polymarket DOWN, mais ce patch empêche cette classe de sur-achat de se reproduire.

4 files changed
+286
-99
Undo

Review
engine.ts
polymarket.ts
engine.test.ts
polymarket.test.ts




4:37 PM
nan mais le problème n'est pas qu'il a payé 7,40$, le problème c'est qu'il l'a fait à 3 reprises et donc ce qui a failli me couter
4:39 PM


Worked for 4m 3s
Tu as raison. J’ai corrigé le deuxième problème, le plus dangereux: la répétition.

Maintenant, pour un hedge BUY Polymarket:

un seul ordre est autorisé par tentative de hedge;
aucun retry Polymarket BUY après un ordre non exactement confirmé;
aucun hedge rescue Polymarket BUY supplémentaire après un hedge failed;
si le hedge Polymarket n’est pas confirmé exact-size, le bot passe à l’unwind/réconciliation au lieu d’envoyer un 2e puis 3e BUY;
log dédié: order.hedge.polymarket_single_submit_guard.
Donc le scénario “Bought 10, puis 11, puis 12 DOWN” est coupé structurellement.

J’ai aussi gardé l’autre correction: Polymarket BUY utilise maintenant size, pas amount, donc même le premier ordre ne peut plus acheter une quantité variable de shares.

Vérifié:

npm run typecheck OK
npm test OK, 221 tests
git diff --check OK
Le compromis volontaire: on désactive le rescue BUY Polymarket agressif. C’est moins opportuniste, mais beaucoup plus sûr: après un hedge Polymarket incertain, on ne rajoute plus d’exposition côté Polymarket.

2 files changed
+115
-285
Undo

Review
engine.ts
engine.test.ts




4:43 PM
On doit réaliser un plan pour patcher proprement tout ça. Les patchs proposés plus tôt ne sont pas bons à mon avis :
Le multi-clipping (retry) pour se hedger est bien et même important pour avoir un meilleur taux de réussite. Là où il faut faire très attention c'est bien comprendre quand c'est réussi. Ici ce qui a causé le gros problème c'est que le bot n'a pas compris qu'il A RÉUSSI à se hedger, a reessayé 2 autres fois, A RÉUSSI À NOUVEAU mais ne l'a pas compris et donc l'a mis en unwound et a mis 22$ pour au final récupérer 10 shares (avec tout l'argent investi, j'en avais presque 30/35 finalement). Donc il y a eu un problème sur le calcul et sur la vérité effective. De même qu'un problème sur la compréhension de ce qu'il s'est passé.

de plus, est-ce vraiment pertinent de passer en shares plutôt qu'en dollar ? Ça ne changerait rien aux modalités actuelles que l'on utilise nan ?

DOnc voilà il faut établir un plan de review sur ce qu'il s'est passé mais aussi checker pour des failles éventuelles qui seraient destructrices comme ce qui a failli se passer (heuresement le pari était gagnant in fine mais le risque pris était immense, victoire à 6$ près...)

Show less
4:51 PM

Je vais d’abord reposer le diagnostic sur le code réel, surtout les chemins Polymarket placeOrder, confirmation trades, retry hedge, et unwind. Ensuite je te proposerai un plan qui conserve le multi-clipping, mais rend la “vérité effective” prioritaire avant tout retry.


Explored 1 search, ran 2 commands
Je vois bien que les derniers patchs locaux ont surtout bloqué les retries Polymarket, ce qui n’est pas la bonne direction si on veut garder le multi-clipping. Je vais inspecter maintenant la couche de vérité Polymarket: comment on relie un orderId aux trades, quels statuts sont considérés confirmés/pending, et pourquoi un fill réel peut rester invisible.


Explored 7 files, 4 searches, 1 list, ran 1 command
Worked for 1m 6s
Fait important trouvé localement: le README du SDK dit explicitement Market buy — amount is in USDC. Donc utiliser amount pour un BUY ne représente pas “10 shares”, mais “dépense jusqu’à X USDC”. Pour une stratégie qui hedgé un nombre de payouts/shares, passer par un ordre limit size est le bon modèle si on veut une vérité exacte sur la quantité. Le vrai patch ne doit pas supprimer le retry; il doit rendre le retry dépendant d’une preuve forte que l’ordre précédent n’a pas fill.

