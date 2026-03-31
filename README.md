# Warbitrer Live BTC 15m

Cockpit et worker live pour la stratégie d’arbitrage BTC 15 minutes entre Polymarket et Kalshi.

## Ce que fait le système

- scan du créneau BTC 15m courant sur Polymarket et Kalshi
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
- `POLY_FUNDER_ADDRESS`
- `POLY_SIGNATURE_TYPE=EOA|POLY_PROXY|POLY_GNOSIS_SAFE`
- `POLY_BRIDGE_LOW_WATER_USDC`

La config de stratégie est stockée en base via `strategy_config`, pas dans les variables d’environnement.
Tu la pilotes via `GET /api/settings` et `PUT /api/settings`.

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
- `GET /api/trades`
- `GET /api/history/current-slot`
- `GET /api/health`
- `GET /api/settings`
- `PUT /api/settings`
- `GET /api/circuit-breakers`
- `PUT /api/circuit-breakers`

## Shadow vs live

- `enableTrading=false` : aucune exécution
- `enableTrading=true` et `shadowMode=true` : intents/ordres/fills synthétiques, même interface, aucune soumission aux venues
- `enableTrading=true` et `shadowMode=false` : exécution live réelle

Le dashboard `/` et la page `/trades` restent les interfaces opérateur principales dans les trois modes.

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

Important: l’interface n’a pas encore d’auth applicative native.
Pour un VPS public, protège l’accès avec `basicauth` côté Caddy, un tunnel SSH, Tailscale, ou une restriction IP.

## Notes d’exploitation

- le trading live reste désactivé tant que `enableTrading` est `false` dans la config
- le mode recommandé pour la montée en charge est d’abord `enableTrading=true` avec `shadowMode=true`
- si une venue est non prête ou si un circuit breaker est actif, le worker refuse d’ouvrir de nouveaux intents
- le rebalance automatique entre cash Kalshi et USDC Polygon n’est pas implémenté; le périmètre treasury est limité au bridge officiel Polymarket
