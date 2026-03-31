# VPS Deployment

Ce dossier contient un pack minimal pour déployer Warbitrer sur un VPS classique.

## Hypothèses

- code cloné dans `/opt/warbitrer-live/app`
- utilisateur système `warbitrer`
- secrets et env dans `/etc/warbitrer/warbitrer.env`
- clé privée Kalshi dans `/etc/warbitrer/kalshi-private-key.pem`
- clé privée Polymarket dans `/etc/warbitrer/polymarket-private-key.txt`
- web servi sur `127.0.0.1:3000`
- HTTPS géré par Caddy avec `basicauth`

## Fichiers

- `warbitrer-web.service`
- `warbitrer-worker.service`
- `Caddyfile`
- `warbitrer.env.example`
- `deploy.sh`

## Installation

1. Créer l’utilisateur:
   `sudo useradd --system --create-home --shell /bin/bash warbitrer`
2. Créer les dossiers:
   `sudo mkdir -p /opt/warbitrer-live /etc/warbitrer`
3. Cloner le repo:
   `sudo -u warbitrer git clone <repo> /opt/warbitrer-live/app`
4. Copier l’env:
   `sudo cp deploy/vps/warbitrer.env.example /etc/warbitrer/warbitrer.env`
5. Mettre les vraies clés dans:
   - `/etc/warbitrer/warbitrer.env`
   - `/etc/warbitrer/kalshi-private-key.pem`
   - `/etc/warbitrer/polymarket-private-key.txt`
6. Installer les dépendances et builder:
   `cd /opt/warbitrer-live/app && npm ci && npm run build`
7. Copier les services:
   - `sudo cp deploy/vps/warbitrer-web.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-worker.service /etc/systemd/system/`
8. Recharger et activer:
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now warbitrer-web`
   - `sudo systemctl enable --now warbitrer-worker`
9. Configurer Caddy avec `deploy/vps/Caddyfile`

## Important sécurité

L’interface n’a pas encore d’auth applicative native.

Ne l’expose pas publiquement sans au minimum:

- `basicauth` côté Caddy
- ou un accès privé via SSH tunnel / Tailscale
- ou une règle IP très restrictive

Le template `Caddyfile` fourni contient déjà un bloc `basicauth` à remplacer.

## Upgrade

Après un `git pull`, lancer:

`bash deploy/vps/deploy.sh`

## Séquence recommandée

1. démarrer avec `enableTrading=false`
2. passer à `enableTrading=true` et `shadowMode=true`
3. vérifier dashboard, intents, fills synthétiques, balances, positions
4. financer Kalshi et Polymarket
5. vérifier que les credentials et allowances sont valides
6. passer à `enableTrading=true` et `shadowMode=false`

## Ce qui doit être prêt avant le live réel

- compte Kalshi approuvé et financé
- wallet/funder Polymarket prêt
- API key L2 Polymarket valide
- allowance collateral Polymarket suffisante
- Postgres opérationnel
- aucune erreur dans `/api/health`
- aucun circuit breaker actif
