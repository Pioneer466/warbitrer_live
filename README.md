# Warbitrer Live Multi-Asset 15m

Cockpit et worker live pour la stratégie d’arbitrage crypto 15 minutes entre Polymarket et Kalshi.

## Ce que fait le système

- market data live `WS-first` avec resync REST de secours sur Polymarket et Kalshi
- scan des créneaux BTC, ETH, SOL, XRP, DOGE, BNB et HYPE 15m courants sur Polymarket et Kalshi
- calcul des opportunités `Poly Up + Kalshi No` et `Poly Down + Kalshi Yes`
- exécution live `taker-only` avec jambe primaire puis hedge immédiat
- reconciliation des ordres, fills, positions, P&L et settlements
- suivi du funding Polymarket via le bridge officiel
- circuit breakers stockés en base et exposés par API

## Pré-requis

- Node 22+
- Postgres obligatoire
- credentials Kalshi
- wallet Polymarket déjà prêt, approvisionné et autorisé

## Variables d’environnement

Voir `.env.example`.

Variables principales:

- `DATABASE_URL`
- `APP_BASIC_AUTH_USER`
- `APP_BASIC_AUTH_PASSWORD`
- `LIVE_EXECUTION_ALLOWED=false|true`
- `TELEGRAM_ENABLED`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `KALSHI_API_KEY_ID`
- `KALSHI_PRIVATE_KEY_PEM`
- `KALSHI_PRIVATE_KEY_PATH`
- `KALSHI_ENV=demo|prod`
- `POLY_PRIVATE_KEY`
- `POLY_PRIVATE_KEY_PATH`
- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`
- `POLY_RELAYER_API_KEY`
- `POLY_RELAYER_URL`
- `POLY_FUNDER_ADDRESS`
- `POLY_SIGNATURE_TYPE=EOA|POLY_PROXY|POLY_GNOSIS_SAFE`
- `POLY_AUTO_CONVERT`
- `POLY_BRIDGE_LOW_WATER_USDC`

Pour Polymarket:

- `POLY_PRIVATE_KEY_PATH` contient la private key du signer `0x...`
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` sont dérivés via `npm run poly:derive-api-key`
- en `POLY_PROXY`, `POLY_FUNDER_ADDRESS` est l’adresse du wallet proxy affiche sur Polymarket, et `POLY_RELAYER_API_KEY` active la conversion gasless `redeem + merge`
- en `EOA`, `POLY_FUNDER_ADDRESS` doit être exactement l’adresse publique du signer
- `POLY_RELAYER_URL` peut rester sur `https://relayer-v2.polymarket.com`

La config de stratégie est stockée en base via `strategy_configs`, pas dans les variables d’environnement.
Tu la pilotes via `GET /api/settings`, `PUT /api/settings`, `GET /api/settings/[asset]` et `PUT /api/settings/[asset]`.

En production, `APP_BASIC_AUTH_USER` et `APP_BASIC_AUTH_PASSWORD` sont obligatoires pour l’application. Les mutations API les vérifient explicitement et refusent aussi les requêtes navigateur cross-site. `LIVE_EXECUTION_ALLOWED` est une autorisation indépendante et fail-closed pour les nouvelles entrées réelles; laisse-la à `false` pour le scan et le shadow.

Champs importants:

- `enableTrading`
- `shadowMode`
- `maxPairNotionalUsd`
- `maxSlippageBps`
- `maxOpenIntentsPerSlot`

## Local

1. `npm install`
2. créer `.env.local`
3. démarrer Postgres
4. `node --env-file=.env.local --import tsx scripts/db-migrate.ts`
5. `npm run dev:all`
6. ouvrir `http://localhost:3000`

Le web et le worker tournent ensemble. Le runtime vérifie le schéma Postgres en lecture seule et refuse de démarrer si `db:migrate` n'a pas appliqué la version attendue.

## Vérification

- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run build:worker`
- `npm run db:status`

## Endpoints utiles

- `GET /api/dashboard`
- `GET /api/dashboard/[asset]`
- `GET /api/trades`
- `GET /api/trades?asset=btc|eth|sol|xrp|doge|bnb|hype|all`
- `GET /api/history/current-slot?asset=btc|eth|sol|xrp|doge|bnb|hype`
- `GET /api/health`
- `GET /api/recovery`
- `GET /api/settings`
- `GET /api/settings/[asset]`
- `PUT /api/settings`
- `PUT /api/settings/[asset]`
- `GET /api/circuit-breakers`
- `PUT /api/circuit-breakers`

## Shadow vs live

- `enableTrading=false` : aucune exécution
- `enableTrading=true` et `shadowMode=true` : simulation `rest-orderbook-v2`, sans soumission aux venues. Dès qu'une opportunité crée un intent, les carnets REST Polymarket et Kalshi sont demandés en parallèle. La paire est évaluée sur ces carnets avec profondeur, haircuts, slippage, frais, taille partielle commune et contrôles économiques. Un fill préparé reste en cours jusqu'à 15 secondes après la création pour simuler le temps d'exécution/confirmation; un échec REST ou un `no_fill` immédiatement démontrable n'attend pas artificiellement.
- `enableTrading=true` et `shadowMode=false` : exécution live réelle uniquement si `LIVE_EXECUTION_ALLOWED=true` et les autres contrôles live sont prêts

En shadow, `maxOpenIntentsPerSlot` ne limite plus tout le créneau. Un seul intent peut être en cours sur un actif, puis un cooldown durable de 60 secondes après sa finalisation autorise une nouvelle tentative si l'opportunité existe encore ou si une autre apparaît. La durée REST, la latence totale, le prochain instant éligible, les fills partiels et les raisons de `no_fill` sont visibles dans `/trades`.

Le dashboard `/` agrège le portefeuille global, `/btc`, `/eth`, `/sol`, `/xrp`, `/doge`, `/bnb` et `/hype` exposent les dashboards opérateur par actif, et `/trades` reste la vue transversale.
La page `/recovery` sert au kill switch global, à la récupération Polymarket, et à la validation wallet.

## Déploiement VPS

Si tu pars sur un VPS en Israël, le repo n’a plus besoin de Railway. Il te faudra côté infra:

- Postgres persistant
- `systemd` avec un service web, un worker par actif, un reconciler et un notifier
- un reverse proxy type Nginx ou Caddy pour HTTPS
- NTP/horloge fiable
- firewall restrictif; l’accès SSH par mot de passe reste disponible, avec une clé SSH optionnelle en complément
- variables d’environnement injectées au niveau du service système, pas dans le repo

Les fichiers et scripts de ce dépôt ne modifient pas `sshd`, `PasswordAuthentication`, les mots de passe système ni les clés SSH, et n’imposent pas un accès key-only.

Concrètement, mets les secrets soit:

- dans `/etc/warbitrer/warbitrer.env` chargé par `systemd`
- ou dans les variables d’environnement du conteneur si tu dockerises

Évite de conserver les vraies clés dans `.env.local` sur le serveur.

Le pack de déploiement prêt à copier est dans [`deploy/vps`](./deploy/vps).

Pour un VPS public, le mode recommandé est:

- `Caddy` devant `127.0.0.1:3000`
- `BasicAuth` applicative obligatoire en production
- `BasicAuth` côté Caddy comme défense externe indépendante
- exposition seulement de `80/443`

Le template est dans [`deploy/vps/Caddyfile`](./deploy/vps/Caddyfile).

## Preview gratuit en ligne

Si tu veux surtout ouvrir le cockpit depuis n'importe où pour vérifier l'état, le repo inclut maintenant un blueprint [`render.yaml`](./render.yaml) pour Render.

Ce mode lance:

- le web public Next.js
- le worker live dans le même service
- un Postgres managé séparé

Points importants:

- c'est adapté à une preview distante, pas à une exploitation live fiable
- un service web `free` Render se met en veille sans trafic entrant, donc le worker s'arrête aussi
- le Postgres `free` Render est limité par le plan du provider; l'app n'implémente aucune purge automatique d'historique
- garde `APP_BASIC_AUTH_USER` et `APP_BASIC_AUTH_PASSWORD` renseignés avant exposition publique

Déploiement:

1. pousser le repo
2. créer un nouveau Blueprint Render depuis ce repo
3. laisser Render créer le service web `warbitrer-live-preview` et la base `warbitrer-live-db`
4. remplir les variables sensibles dans l'UI Render
5. ouvrir l'URL Render générée

Pour ce mode, le démarrage passe par `npm run start:render`.

Pourquoi pas Vercel seul:

- le site dépend d'un worker Node long-running qui tourne en continu
- Vercel convient au web Next.js, mais pas comme hébergement unique de ce worker live
- si tu veux du vrai live accessible partout, il faut soit un petit VPS, soit un provider qui héberge web + worker + Postgres ensemble

## Notes d’exploitation

- le trading live reste désactivé tant que `enableTrading` est `false` dans la config
- une configuration live ne suffit pas: `LIVE_EXECUTION_ALLOWED=true` et un `POLYGON_RPC_URL` Polygon mainnet fonctionnel doivent aussi être présents dans l’environnement du runtime
- le mode recommandé pour la montée en charge est d’abord `enableTrading=true` avec `shadowMode=true`
- si une venue est non prête ou si un circuit breaker est actif, le worker refuse d’ouvrir de nouveaux intents
- un fill Polymarket n’est comptabilisé comme final qu’après validation de son reçu Polygon et de l’événement V2 `OrderFilled`, frais exacts inclus
- tout fill inséré après V8, même sur un intent legacy, doit passer par la transaction comptable atomique; un fill tardif met l’intent en quarantaine avant tout recalcul
- ne jamais déployer tant qu’un intent live, une tentative d’ordre live ou une exposition en capital est non terminale; réconcilier d’abord la vérité venue, surtout lors d’un changement de génération des client order IDs
- si Telegram est configuré, le worker n’envoie que 2 types de notifications: `trade_live` quand un intent live engage réellement du capital, et `manual_intervention_required` quand une action humaine est requise
- le rebalance automatique entre cash Kalshi et USDC Polygon n’est pas implémenté; le périmètre treasury est limité au bridge officiel Polymarket
