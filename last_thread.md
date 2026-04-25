# Handoff – Current Session Summary

Date: 2026-04-25  
Repo: `warbitrer-live`

## 1. Projet global

Projet d’arbitrage live multi-assets entre **Kalshi** et **Polymarket** sur marchés directionnels crypto courts (`UP/DOWN 15m`), avec :

- un worker d’exécution
- une app Next.js pour dashboard / trades / recovery
- settlement, recovery, circuit breakers, notifications Telegram

Objectifs récents du thread :

1. corriger les bugs de settlement / mismatch
2. durcir les guardrails
3. améliorer l’exécution primaire Kalshi
4. améliorer l’observabilité des `Primary order not filled`
5. garder un handoff réutilisable après perte de session

---

## 2. Très gros sujets traités dans cette session

### 2.1 Settlement faux sur les intents historiques

Bug grave observé :

- des intents `settled` affichaient par exemple :
  - `Polymarket DOWN`
  - `Kalshi NO`
- alors que la vérité venue était :
  - `Polymarket DOWN`
  - `Kalshi YES`

Conséquence :

- faux `aligné`
- faux `P&L`
- mauvaise lecture du mismatch réel

### Cause réelle identifiée

Il y avait plusieurs causes successives :

1. ancien fallback de settlement qui pouvait réécrire les résolutions à partir d’une `referenceResolution` externe au lieu des vraies venues
2. `fetchKalshiResolution()` était trop strict et n’acceptait pas assez de statuts terminaux Kalshi
3. le refresh de settlement ne retrouvait pas certains slots historiques Polymarket via `gamma-api /markets?slug=...`

### Correctifs appliqués

- suppression du fallback de settlement basé sur une référence externe
- settlement basé sur les vraies résolutions venues
- `fetchKalshiResolution()` accepte maintenant les statuts terminaux :
  - `determined`
  - `settled`
  - `finalized`
- fallback Polymarket historique :
  - d’abord `gamma-api /markets?slug=...`
  - puis fallback `gamma-api /events?slug=...`
  - sélection du bon market via le `conditionId` / `marketRef` stocké sur la jambe
- refresh manuel des settlements disponible via :
  - `POST /api/recovery/settlements`

### Vérification VPS déterminante

Intent audité :

- `e494decd-41eb-44b4-8cd8-f49a42278b07`
- combo : `ETH · POLY_UP_KALSHI_NO`

Résultats trouvés sur VPS :

- DB stockait : `poly_resolution = DOWN`, `kalshi_resolution = NO`
- Kalshi API sur `KXETH15M-26APR240530-30` renvoyait :
  - `result = yes`
  - `status = finalized`
- Polymarket `gamma-api /markets?slug=eth-updown-15m-1777022100` renvoyait `[]`
- Polymarket `gamma-api /events?slug=eth-updown-15m-1777022100` retrouvait bien le marché historique

Conclusion :

- le faux `NO` Kalshi était bien un bug
- le repair échouait surtout parce que la lookup Polymarket par `slug` seul était insuffisante

---

## 3. Refresh settlements / backfill

Un endpoint existe maintenant pour recalculer les settlements :

- route : `src/app/api/recovery/settlements/route.ts`
- logique : `repairSettledIntentResolutions()` dans `src/lib/engine.ts`

### Ce que fait le batch

- lit les intents `settled` récents
- relit les résolutions venues
- recalcule :
  - `polyResolution`
  - `kalshiResolution`
  - `realizedPnlUsd`
- réécrit l’intent si nécessaire

### Évolution récente

Le batch supporte maintenant :

- `includeShadow: true`

Cela permet de recalculer aussi les intents shadow sur une fenêtre de 48h.

### Commandes utiles VPS

Charger l’env :

```bash
set -a
source /etc/warbitrer/warbitrer.env
set +a
```

Refresh 48h sur tous les assets, live + shadow :

```bash
curl -sS -u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD" \
  -X POST http://127.0.0.1:3000/api/recovery/settlements \
  -H 'Content-Type: application/json' \
  -d '{"asset":"all","lookbackHours":48,"limit":5000,"includeShadow":true}'
```

Refresh 48h sur ETH seulement :

```bash
curl -sS -u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD" \
  -X POST http://127.0.0.1:3000/api/recovery/settlements \
  -H 'Content-Type: application/json' \
  -d '{"asset":"eth","lookbackHours":48,"limit":2000,"includeShadow":true}'
```

Refresh d’un intent précis :

```bash
curl -sS -u "$APP_BASIC_AUTH_USER:$APP_BASIC_AUTH_PASSWORD" \
  -X POST http://127.0.0.1:3000/api/recovery/settlements \
  -H 'Content-Type: application/json' \
  -d '{"intentId":"e494decd-41eb-44b4-8cd8-f49a42278b07"}'
```

---

## 4. UI / Trades

### Point important

L’utilisateur a explicitement dit :

- il ne voulait pas de “fix UI superficiel”
- le problème principal était la vérité du settlement

Donc :

- il fallait corriger la donnée stockée avant toute chose

### Dernier correctif UI ciblé

Il restait un bug de badge :

- `incomplet` s’affichait parfois à la place de `mismatch`

Cause :

- `getResolutionAlignment()` dans `src/components/trades-client.tsx` sortait trop tôt quand la direction normalisée divergeait

Correctif :

- si les deux résolutions existent et divergent, c’est maintenant bien `mismatch`
- `incomplet` ne s’affiche plus que s’il manque une résolution

---

## 5. Guardrails mismatch

### Constat actuel

Même après avoir réparé les settlements, on voit encore :

- des mismatchs réels
- parfois nombreux

Conclusion importante :

- la stratégie reste **faillible**
- les guardrails actuels ne suffisent pas

### Lecture correcte

Avant :

- une partie du bruit venait des bugs de settlement

Maintenant :

- ce qui reste est beaucoup plus proche du **vrai risque métier**

### Direction recommandée pour la suite

La prochaine amélioration logique n’est plus de la plomberie mais du **guardrail produit**, par exemple :

1. **guard combo-spécifique**
  - distinguer :
    - `POLY_UP_KALSHI_NO`
    - `POLY_DOWN_KALSHI_YES`
2. **dead-zone guard explicite**
  - si `polyOpen` et `kalshiTarget` sont trop éloignés
  - certaines combinaisons ont une zone où les deux jambes perdent
3. **analyse empirique du mismatch**
  - mismatch rate par asset
  - par combinaison
  - selon `|polyOpen - kalshiTarget|`
  - selon `chainlinkMoveBps`

---

## 6. Exécution primaire Kalshi – problème majeur encore ouvert

### Symptôme

Beaucoup trop de :

- `Primary order not filled`
- `filled 0.00`
- sur des tailles souvent de `15` à `22` contrats

Exemples fournis par l’utilisateur :

- BTC `req 22.00` → `filled 0.00`
- BTC `req 21.00` → `filled 0.00`
- ETH `req 21.00` → `filled 0.00`
- ETH `req 15.00` → `filled 0.00`
- XRP `req 12.00` → `filled 0.00`

### Question de l’utilisateur

> Avant, quand Kalshi était en hedge, ça passait bien avec les retries.  
> Pourquoi c’est devenu si compliqué en primary fills ?

### Réponse technique donnée

La différence vient surtout de 3 éléments :

1. **la primary Kalshi revalide toute la paire**
  - prix Poly
  - prix Kalshi
  - gross cost
  - taille commune exécutable
2. **la primary Kalshi porte souvent une taille plus grosse**
  - 15 à 22 contrats
3. **le hedge est plus persistant**
  - plus de retries
  - et surtout il couvre une exposition déjà ouverte, donc il est autorisé à être plus agressif

Donc :

- la primary est plus contrainte économiquement
- le hedge est plus contraint par l’urgence de couverture

### Point de confusion important

Les logs côté user montrent encore :

- `fill_or_kill_insufficient_resting_volume`

alors que le code local envoie bien la **primary Kalshi en `IOC`**, pas en `FOK`.

Code actuel :

- `engine.ts`: primary Kalshi via `buildVenueOrderRequest(..., "IOC", ...)`
- `kalshi.ts`: `time_in_force` est :
  - `fill_or_kill` si `orderType === "FOK"`
  - `immediate_or_cancel` sinon

Le message Kalshi contenant `fill_or_kill` ne prouve donc pas à lui seul que l’ordre envoyé était effectivement en `FOK`.

---

## 7. Hypothèse actuelle sur les no-fills primary Kalshi

L’utilisateur a proposé une analyse très plausible :

### Hypothèse A

Book mouvant entre snapshot et submit :

- la depth visible au moment du WS est réelle
- mais elle disparaît avant traitement de l’ordre

### Hypothèse B

Ghost depth / depth trompeuse :

- le WS montre une depth qui n’est pas réellement exécutable

### Indice fort relevé

Les échecs arrivent souvent :

- 1 à 7 minutes après ouverture du slot

C’est censé être la zone la plus liquide, donc ça rend l’hypothèse **B** plus inquiétante.

---

## 8. Télémétrie ajoutée pour trancher A vs B

### Objectif

Ne **pas** changer le comportement pour l’instant, juste observer proprement.

### Ajouts réalisés

Sur les events :

- `order.primary.submitted`
- `order.primary.clip_submitted`
- `order.primary.resubmitted`

le payload inclut maintenant :

- `orderType`

Sur chaque :

- `order.primary.no_fill`

le payload inclut maintenant :

- `kalshiBookWsAtFailure`
- `kalshiBookRestAtFailure`

### Ce que contient la télémétrie REST

Snapshot REST direct de l’orderbook Kalshi après le zéro-fill :

- `topPrice`
- `topDepth`
- `limitPrice`
- `requestedSize`
- `cumulativeDepthWithinLimit`
- `topLevels`
- `seq`

### Lecture attendue

Si :

- `REST cumulativeDepthWithinLimit ≈ 0`

alors on est surtout sur **A** :

- le book a bougé / disparu entre snapshot et submit

Si :

- `REST cumulativeDepthWithinLimit` reste largement supérieur à la taille demandée
- mais l’ordre revient `filled 0.00`

alors on a un vrai soupçon **B** :

- depth trompeuse / ghost depth / mismatch entre book visible et exécutable

### Important

Le facteur défensif `cumulativeDepth × 0.7` **n’a pas été appliqué** pour l’instant.

Décision prise :

- d’abord mesurer proprement
- ensuite seulement durcir le sizing si les données le justifient

---

## 9. Stratégie d’exécution Kalshi déjà en place

Les dernières grosses évolutions déjà codées dans le repo :

### Primary Kalshi

- `IOC` au lieu de `FOK`
- partial fills primaires traités comme exploitables
- hedge redimensionné sur la taille réellement remplie
- cumul de depth Kalshi dans la fenêtre de prix
- slippage Kalshi en **ticks** (`kalshiPrimaryPriceTicksSlippage`)
- multi-clip primaire Kalshi
- logging de book au submit

### Multi-clip

Toujours présent.

Il n’est pas systématique :

- il dépend de la taille demandée
- il suit actuellement un plan par taille (`kalshiPrimaryMaxClipContracts`, `kalshiPrimaryMaxClips`)

Réflexion discutée mais non implémentée :

- clipping par **niveau de prix**

Décision actuelle :

- ne pas aller vers du level-aware client-side tout de suite
- observer d’abord ce que donne l’IOC simple / multi-clip actuel

---

## 10. Valeurs de config importantes actuellement

### `kalshiPrimaryPriceTicksSlippage`

Valeur par défaut actuelle dans le code :

- `2`

Références :

- `src/lib/constants.ts`
- `DEFAULT_KALSHI_PRIMARY_PRICE_TICKS_SLIPPAGE = 2`

Commande VPS pour voir la valeur réellement persistée :

```bash
sudo -u postgres psql -d warbitrer_live -P pager=off <<'SQL'
SELECT
  asset,
  payload->>'kalshiPrimaryPriceTicksSlippage' AS kalshi_primary_price_ticks_slippage
FROM strategy_configs
ORDER BY asset;
SQL
```

Si `NULL` :

- l’asset utilise le défaut `2`

### Autres defaults utiles

- `kalshiDepthHeadroomContracts = 2`
- `kalshiPrimaryMaxClipContracts = 10`
- `kalshiPrimaryMaxClips = 4`
- `primaryRetryAttempts = 2`
- `primaryRetryDelayMs = 200`
- `hedgeRetryAttempts = 3`
- `hedgeRetryDelayMs = 350`

---

## 11. Notifications Telegram

Implémentées proprement dans la session.

Objectif choisi :

- **pas de spam**
- seulement :
  1. un vrai trade live pris
  2. une action humaine requise

### Variables env

Dans `.env` / env VPS :

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Notes utiles

- l’utilisateur a récupéré un token Telegram valide
- `getMe` OK
- plus tôt dans le thread, un vrai token a été exposé en clair dans la conversation
- recommandation faite :
  - le révoquer via BotFather
  - utiliser un nouveau token en prod

---

## 12. État de validation local au dernier passage

À la fin de la session, après les derniers patchs :

- `npm run typecheck` OK
- `npm test` OK
- `npm run build` OK

Le nombre de tests était à ce moment-là :

- `19 files`
- `166 tests`

---

## 13. Ce qu’il faut regarder tout de suite après redéploiement

### Côté no-fills primary Kalshi

Sur le prochain `order.primary.no_fill`, inspecter le payload :

- `orderType`
- `kalshiBookWsAtFailure`
- `kalshiBookRestAtFailure`

Comparer :

- `requestedSize`
- `limitPrice`
- `cumulativeDepthWithinLimit` côté WS
- `cumulativeDepthWithinLimit` côté REST

### Interprétation

- REST faible / nul → problème A (book bougé)
- REST élevé mais no-fill → problème B (ghost depth / inconsistance plus grave)

---

## 14. Questions / sujets tout récents de l’utilisateur

Dernières préoccupations explicites :

1. beaucoup trop de `Primary order not filled`
2. besoin de comprendre pourquoi Kalshi hedge passait mieux que Kalshi primary
3. besoin de savoir la valeur actuelle de `kalshiPrimaryPriceTicksSlippage`
4. besoin d’enregistrer cette session / cette conversation

Le présent fichier sert précisément à ça :

- relancer une nouvelle session avec du contexte exploitable
- sans dépendre de l’historique UI

---

## 15. Prochaines étapes recommandées

Ordre conseillé :

1. **déployer le dernier patch de télémétrie no-fill**
2. attendre 2 à 5 nouveaux `primary no-fill`
3. lire les payloads `kalshiBookWsAtFailure` / `kalshiBookRestAtFailure`
4. seulement ensuite décider :
  - safety factor de sizing type `×0.7`
  - durcissement du clip initial
  - ou remise à plat de la lecture de depth Kalshi

En parallèle :

1. poursuivre ensuite sur les **guardrails combo-spécifiques** pour réduire les mismatchs structurels

---

## 16. Si une nouvelle session repart de ce fichier

Résumé ultra court :

- settlement historiquement faux corrigé
- refresh settlements 48h disponible, y compris shadow
- gros problème encore ouvert = `Primary order not filled` Kalshi
- nouvelle télémétrie ajoutée pour trancher `book mouvant` vs `ghost depth`
- prochain vrai travail = observer les prochains no-fills, puis décider si on applique un sizing défensif ou une autre correction plus profonde

