# Warbitrer Live BTC + ETH 15m

Cockpit et worker live pour la stratégie d’arbitrage BTC et ETH 15 minutes entre Polymarket et Kalshi.

## Ce que fait le système

- market data live `WS-first` avec resync REST de secours sur Polymarket et Kalshi
- scan des créneaux BTC et ETH 15m courants sur Polymarket et Kalshi
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
4. `npm run dev:all`
5. ouvrir `http://localhost:3000`

Le web et le worker tournent ensemble. Le worker crée automatiquement le schéma Postgres au premier démarrage.

## Vérification

- `npm run typecheck`
- `npm test`
- `npm run build`

## Endpoints utiles

- `GET /api/dashboard`
- `GET /api/dashboard/[asset]`
- `GET /api/trades`
- `GET /api/trades?asset=btc|eth|all`
- `GET /api/history/current-slot?asset=btc|eth`
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
- `enableTrading=true` et `shadowMode=true` : intents/ordres/fills synthétiques, même interface, aucune soumission aux venues
- `enableTrading=true` et `shadowMode=false` : exécution live réelle

Le dashboard `/` agrège le portefeuille global, `/btc` et `/eth` exposent les dashboards opérateur par actif, et `/trades` reste la vue transversale.
La page `/recovery` sert au kill switch global, à la récupération Polymarket, et à la validation wallet.

## Déploiement VPS

Si tu pars sur un VPS en Israël, le repo n’a plus besoin de Railway. Il te faudra côté infra:

- Postgres persistant
- un process manager pour le web + worker, typiquement `systemd`
- un reverse proxy type Nginx ou Caddy pour HTTPS
- NTP/horloge fiable
- firewall restrictif et accès SSH par clé
- variables d’environnement injectées au niveau du service système, pas dans le repo

Concrètement, mets les secrets soit:

- dans `/etc/warbitrer/warbitrer.env` chargé par `systemd`
- ou dans les variables d’environnement du conteneur si tu dockerises

Évite de conserver les vraies clés dans `.env.local` sur le serveur.

Le pack de déploiement prêt à copier est dans [`deploy/vps`](./deploy/vps).

Pour un VPS public, le mode recommandé est:

- `Caddy` devant `127.0.0.1:3000`
- `BasicAuth` côté Caddy
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
- le mode recommandé pour la montée en charge est d’abord `enableTrading=true` avec `shadowMode=true`
- si une venue est non prête ou si un circuit breaker est actif, le worker refuse d’ouvrir de nouveaux intents
- le rebalance automatique entre cash Kalshi et USDC Polygon n’est pas implémenté; le périmètre treasury est limité au bridge officiel Polymarket
