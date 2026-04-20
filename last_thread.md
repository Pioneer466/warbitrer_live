
# Handoff – Vérifier et finaliser l’implémentation multi-assets BTC + ETH 15m

## Contexte

Le projet `warbitrer-live` était initialement  **single-market BTC 15m** .
Une refonte importante a été lancée pour supporter **BTC + ETH 15m** avec  **la même logique d’arbitrage** , dans  **un seul worker** , avec  **config/trading séparés par actif** .

Le thread précédent a crash pendant la compaction de contexte Cursor,  **après une grosse série de modifications** .
Il faut donc  **partir du principe que l’implémentation est peut-être presque finie, mais pas encore validée de bout en bout** .

---

## Ce qui a été entrepris

Objectif d’architecture retenu :

* introduire `MarketAsset = "btc" | "eth"`
* créer un catalogue centralisé des marchés par actif
* rendre `MarketSlot` asset-aware
* namespacer `slotKey` en `${asset}:${slotStartTs}`
* généraliser :
  * `slot`
  * `kalshi`
  * `polymarket`
  * `market-data`
  * `signals`
  * `settlement`
  * `engine`
  * résolution market / Coinbase
* faire tourner `processTick()` sur `["btc", "eth"]`
* rendre la DB asset-aware
* rendre l’API asset-aware
* rendre l’UI asset-aware avec :
  * `/` = portfolio global
  * `/btc` = dashboard BTC
  * `/eth` = dashboard ETH
  * `/trades` = global filtrable
  * `/recovery` = global groupé par actif

---

## Point crucial

Le précédent assistant indiquait avoir déjà modifié  **environ 34 fichiers** , avec un état annoncé comme :

* backend presque en place
* runtime principal proche de compiler
* UI opérateur de base en place
* **dernier gros bloc restant : fixtures/tests**

La dernière trace utile avant le crash disait en substance :

* la logique multi-assets semblait tenir
* les tests / fixtures restaient probablement incomplets
* le crash est intervenu pendant la phase finale de normalisation des tests

Donc :

## hypothèse de travail

L’implémentation est  **probablement largement faite** , mais  **pas forcément validée** .

Il faut  **vérifier l’état réel du repo avant toute nouvelle modif fonctionnelle** .

---

## Fichiers explicitement modifiés selon le thread

La refonte multi-assets a touché au moins :

* `app/api/.../route.ts` (plusieurs routes)
* `app/.../page.tsx`
* `layout.tsx`
* `dashboard-client.tsx`
* `portfolio-client.tsx`
* `recovery-client.tsx`
* `shell.tsx`
* `trades-client.tsx`
* `trading-toggle.tsx`
* `src/lib/btc-resolution.ts`
* `src/lib/constants.ts`
* `src/lib/engine.ts`
* `src/lib/kalshi.ts`
* `src/lib/market-catalog.ts`
* `src/lib/market-data.ts`
* `src/lib/market-resolution.ts`
* `src/lib/polymarket.ts`
* `src/lib/postgres-db.ts`
* `src/lib/recovery.ts`
* `src/lib/settings-schema.ts`
* `src/lib/settlement.ts`
* `src/lib/signals.ts`
* `src/lib/slot.ts`
* `src/lib/storage.ts`
* `src/lib/types.ts`
* `src/worker/index.ts`

Il y avait aussi des créations de nouvelles pages/composants pour le mode portfolio + dashboards par actif.

---

## Ce qu’il faut faire maintenant

Ne pas repartir de zéro.
Il faut **capitaliser sur les modifications déjà présentes** et faire un audit structuré.

### Étape 1 — Vérifier l’état réel du workspace

Commencer par :

```bash
git status --short
git diff --stat
npm run typecheck
npm test
npm run build
```

Objectif :

* voir si le workspace contient encore les changements multi-assets
* voir si ça compile
* voir si les tests cassent
* identifier si le refactor est “fini mais non validé” ou “encore cassé”

---

### Étape 2 — Vérifier les invariants d’architecture

Confirmer dans le code que les points suivants sont bien en place :

#### Domaine / types

* `MarketAsset = "btc" | "eth"`
* catalogue centralisé BTC/ETH
* `MarketSlot` contient `asset`
* `slotKey` namespacé en `${asset}:${slotStartTs}`

#### Runtime

* `processTick()` scanne bien BTC + ETH à chaque cycle
* logique d’exécution/reconcile séparée par actif
* pas de collision d’état entre BTC et ETH

#### DB / storage

* tables config/state par actif :
  * `strategy_configs(asset primary key, ...)`
  * `worker_states(asset primary key, ...)`
* `asset` ajouté aux tables métier :
  * `opportunity_snapshots`
  * `order_intents`
  * `venue_orders`
  * `fills`
  * `positions`
  * `settlements`
* `run_events.asset` nullable
* `venue_balances`, `pnl_snapshots`, `bridge_transfers` restent globaux
* circuit breakers normalisés :
  * `global`
  * `asset:btc`
  * `asset:eth`
  * `slot:btc:<slotKey>`
  * `slot:eth:<slotKey>`

#### API

* `GET /api/dashboard` = résumé global portfolio
* `GET /api/dashboard/[asset]`
* `GET /api/history/current-slot?asset=...`
* `GET /api/settings`
* `GET/PUT /api/settings/[asset]`
* `GET /api/trades?asset=btc|eth|all`
* `GET /api/health` = état global + résumé par actif

#### UI

* `/` = portfolio global
* `/btc` = dashboard BTC
* `/eth` = dashboard ETH
* `/trades` filtrable
* `/recovery` groupé par actif
* toggle de trading par actif, pas global

---

### Étape 3 — Vérifier le comportement de bootstrap / migration

Contrôler si le code fait bien ceci :

* ETH initialisé avec la config BTC
* mais :
  * `enableTrading=false`
  * `shadowMode=true`
* backfill de l’historique BTC avec `asset='btc'`
* anciennes tables singleton laissées en place si rollback prévu

Si ce point n’est pas fini, le compléter.

---

### Étape 4 — Vérifier les tests attendus

Les tests à confirmer ou compléter :

1. BTC et ETH partagent les bornes 15m mais ont :
   * slotKey distinct
   * slugs Polymarket distincts
   * séries Kalshi distinctes
   * produit Coinbase distinct
2. découverte ETH correcte sur :
   * `KXETH15M`
   * `eth-updown-15m-*`
3. un tick worker :
   * scanne BTC et ETH
   * écrit des snapshots séparés
   * respecte `enableTrading` / `shadowMode` par actif
4. migration / backfill :
   * historique BTC visible avec `asset='btc'`
   * settings/state lisibles/modifiables par actif
5. UI/API :
   * `/`
   * `/btc`
   * `/eth`
   * `/trades?asset=...`
   * `/api/history/current-slot?asset=...`
   * toggles settings par actif

---

## Ce qu’il ne faut PAS faire

* ne pas réécrire toute l’architecture depuis zéro avant d’avoir vérifié l’existant
* ne pas supposer que le refactor est fini juste parce que beaucoup de fichiers ont changé
* ne pas supposer non plus qu’il est cassé partout : il est possible qu’il manque seulement les fixtures/tests ou quelques callsites

---

## Mission immédiate pour cette nouvelle conversation

Je veux que tu :

1. **audites l’implémentation multi-assets déjà présente dans le repo**
2. **me dises précisément si elle est terminée ou non**
3. **m’indiques ce qui manque exactement**
4. **finalises seulement les morceaux manquants**
5. **me donnes ensuite la procédure de validation et de déploiement**

Commence par :

* lire l’état actuel du code
* lancer les vérifications (`git diff`, `typecheck`, `test`, `build`)
* puis me faire un diagnostic structuré :
  * **fait**
  * **partiellement fait**
  * **manquant**
  * **cassé**
