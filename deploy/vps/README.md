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
- `warbitrer-postgres-backup.service`
- `warbitrer-postgres-backup.timer`
- `Caddyfile`
- `Caddyfile.public-ip`
- `warbitrer.env.example`
- `backup-postgres.sh`
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
   - `sudo cp deploy/vps/warbitrer-postgres-backup.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-postgres-backup.timer /etc/systemd/system/`
8. Recharger et activer:
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now warbitrer-web`
   - `sudo systemctl enable --now warbitrer-worker`
   - `sudo systemctl enable --now warbitrer-postgres-backup.timer`
9. Configurer Caddy avec `deploy/vps/Caddyfile`
10. Générer le mot de passe Caddy:
   - `caddy hash-password --plaintext 'CHANGE_ME'`
11. Remplacer le domaine `warbitrer.example.com` et le hash dans `/etc/caddy/Caddyfile`
12. Ouvrir `80/tcp` et `443/tcp`, puis:
   - `sudo systemctl reload caddy`

## Exposition directe par IP publique

Si tu n'as pas encore de domaine, tu peux exposer le cockpit directement via l'IP publique du VPS.

Mode recommandé pour ce cas:

- web Warbitrer toujours sur `127.0.0.1:3000`
- worker séparé via `systemd`
- Caddy en reverse proxy sur `80/tcp`
- pas d'exposition directe du port `3000`

Fichier dédié:

- `deploy/vps/Caddyfile.public-ip`

Procédure:

1. copier le template:
   `sudo cp deploy/vps/Caddyfile.public-ip /etc/caddy/Caddyfile`
2. remplacer `YOUR_SERVER_IP` par l'IP publique réelle du VPS
3. générer un hash de mot de passe:
   `caddy hash-password --plaintext 'CHANGE_ME'`
4. remplacer le hash placeholder dans `/etc/caddy/Caddyfile`
5. vérifier que le web Warbitrer écoute seulement en local:
   `sudo ss -ltnp | grep 3000`
6. ouvrir seulement `80/tcp` au firewall
7. garder `3000/tcp` fermé publiquement
8. recharger Caddy:
   `sudo systemctl reload caddy`
9. ouvrir:
   `http://IP_DU_VPS`

Notes importantes:

- ce mode est en HTTP, pas en HTTPS
- l'auth Basic sur HTTP protège l'accès casual mais ne protège pas la confidentialité du mot de passe sur le réseau
- si tu veux un accès distant plus sûr sans domaine, préfère `Tailscale` ou un tunnel SSH
- si tu acceptes l'exposition HTTP temporaire, utilise un mot de passe long et unique

## Robustesse DB

Le repo inclut maintenant deux garde-fous côté DB:

- rétention automatique exécutée par le worker
- backup Postgres quotidien via `systemd timer`

Variables utiles dans `/etc/warbitrer/warbitrer.env`:

- `DB_MAINTENANCE_INTERVAL_MINUTES`
- `DB_RETENTION_SNAPSHOTS_HOURS`
- `DB_RETENTION_PNL_DAYS`
- `DB_RETENTION_RUN_EVENTS_DAYS`
- `DB_RETENTION_FILLS_DAYS`
- `DB_RETENTION_ORDERS_DAYS`
- `DB_RETENTION_CLOSED_INTENTS_DAYS`
- `DB_RETENTION_SETTLEMENTS_DAYS`
- `DB_RETENTION_BRIDGE_TRANSFERS_DAYS`

Valeur `0` sur une rétention = désactivation du nettoyage pour cette table.

Backup:

1. copier les unités:
   - `sudo cp deploy/vps/warbitrer-postgres-backup.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-postgres-backup.timer /etc/systemd/system/`
2. recharger:
   - `sudo systemctl daemon-reload`
3. activer le timer:
   - `sudo systemctl enable --now warbitrer-postgres-backup.timer`
4. test manuel:
   - `sudo systemctl start warbitrer-postgres-backup.service`
5. vérifier:
   - `sudo systemctl status warbitrer-postgres-backup.timer --no-pager`

Le script écrit par défaut dans:

- `/opt/warbitrer-live/backups/postgres`

Variables optionnelles:

- `BACKUP_DIR`
- `BACKUP_RETENTION_DAYS`

## Important sécurité

L’interface n’a pas encore d’auth applicative native.

Ne l’expose pas publiquement sans au minimum:

- `basicauth` côté Caddy
- ou un accès privé via SSH tunnel / Tailscale
- ou une règle IP très restrictive

Le template `Caddyfile` fourni contient déjà un bloc `basicauth` à remplacer.

Pour un accès par IP publique sans domaine, utiliser `deploy/vps/Caddyfile.public-ip` au lieu du template domaine.

## Temps réel

Le worker maintient maintenant une couche market data persistante:

- `Polymarket`: market channel WebSocket + resync REST
- `Kalshi`: WebSocket quand disponible + resync orderbook/trades REST
- les snapshots affichés par le dashboard sont compactés en base chaque seconde
- aucune opportunité n’est exécutable si un feed est `degraded` ou `blocked`

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

## Wallet Polymarket

Voir aussi `deploy/vps/EOA_RUNBOOK.md`.

En mode `POLY_PROXY` actuel:

- `POLY_PRIVATE_KEY_PATH` = clé privée du signer EOA `0x...`
- `POLY_FUNDER_ADDRESS` = adresse du proxy/funder Polymarket
- `POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE` = dérivés via `npm run poly:derive-api-key`
- `POLY_RELAYER_API_KEY` = relayer API key créée depuis Polymarket > Settings > API Keys
- `POLY_RELAYER_URL` = `https://relayer-v2.polymarket.com`
- `POLY_AUTO_CONVERT=true` active la conversion automatique `redeem + merge` via le relayer gasless

En mode `EOA` futur:

- `POLY_SIGNATURE_TYPE=EOA`
- `POLY_AUTO_CONVERT=true` pour activer la conversion automatique `redeem + merge`
- `POLY_FUNDER_ADDRESS` doit être exactement l’adresse publique du signer
- `POLYGON_RPC_URL` doit être renseigné pour le redeem/merge direct
- la page `/recovery` vérifie déjà si la migration EOA est techniquement prête
