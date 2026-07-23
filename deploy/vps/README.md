# VPS Deployment

Ce dossier contient un pack minimal pour déployer Warbitrer sur un VPS classique.

## Hypothèses

- code cloné dans `/opt/warbitrer-live/app`
- utilisateur système `warbitrer`
- secrets et env dans `/etc/warbitrer/warbitrer.env`
- clé privée Kalshi dans `/etc/warbitrer/kalshi-private-key.pem`
- clé privée Polymarket dans `/etc/warbitrer/polymarket-private-key.txt`
- web servi sur `127.0.0.1:3000`
- authentification applicative configurée avec `APP_BASIC_AUTH_USER` et `APP_BASIC_AUTH_PASSWORD`
- HTTPS géré par Caddy avec un second `basicauth` externe
- accès SSH par mot de passe conservé; une clé SSH reste optionnelle

## Fichiers

- `warbitrer-web.service`
- `warbitrer-asset@.service`
- `warbitrer-reconciler.service`
- `warbitrer-notifier.service`
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
6. Installer les dépendances et builder en tant que `warbitrer`:
   `cd /opt/warbitrer-live/app && sudo -u warbitrer -H npm ci && sudo -u warbitrer -H npm run build && sudo -u warbitrer -H npm run build:worker`
7. Après un backup vérifié, charger `/etc/warbitrer/warbitrer.env` sans afficher son contenu, puis exécuter `npm run db:migrate` et `npm run db:status` en tant que `warbitrer` comme décrit dans `docs/codex/deployment.md`.
8. Copier les services:
   - `sudo cp deploy/vps/warbitrer-web.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-asset@.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-reconciler.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-notifier.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-postgres-backup.service /etc/systemd/system/`
   - `sudo cp deploy/vps/warbitrer-postgres-backup.timer /etc/systemd/system/`
   - sur une ancienne installation uniquement: désactiver `warbitrer-worker`, supprimer `/etc/systemd/system/warbitrer-worker.service`, puis exécuter `sudo systemctl daemon-reload`
9. Recharger et activer:
   - `sudo systemctl daemon-reload`
   - `sudo systemctl enable --now warbitrer-web`
   - `sudo systemctl enable --now warbitrer-asset@btc warbitrer-asset@eth warbitrer-asset@sol warbitrer-asset@xrp warbitrer-asset@doge`
   - `sudo systemctl enable --now warbitrer-reconciler warbitrer-notifier`
   - `sudo systemctl enable --now warbitrer-postgres-backup.timer`
10. Configurer Caddy avec `deploy/vps/Caddyfile`
11. Générer le mot de passe Caddy:

- `caddy hash-password --plaintext 'CHANGE_ME'`

12. Remplacer le domaine `warbitrer.example.com` et le hash dans `/etc/caddy/Caddyfile`
13. Ouvrir `80/tcp` et `443/tcp`, puis:

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

En production, l’application refuse les accès protégés si l’une des deux variables `APP_BASIC_AUTH_USER` ou `APP_BASIC_AUTH_PASSWORD` manque. Les routes de mutation vérifient à nouveau cette authentification et refusent les requêtes navigateur cross-site.

Conserver plusieurs couches:

- `basicauth` applicative obligatoire
- `basicauth` côté Caddy comme défense externe indépendante
- HTTPS, Tailscale, tunnel SSH ou règle IP restrictive selon l’exposition

Le template `Caddyfile` fourni contient un bloc `basicauth` à remplacer. La protection Caddy ne remplace pas l’authentification applicative.

Pour un accès par IP publique sans domaine, utiliser `deploy/vps/Caddyfile.public-ip` au lieu du template domaine.

Les scripts de ce dépôt ne modifient ni `sshd`, ni `PasswordAuthentication`, ni les identifiants système. L’opérateur doit pouvoir continuer à se connecter par mot de passe; l’ajout d’une clé SSH est facultatif et peut coexister avec ce mode.

## Temps réel

Le worker maintient maintenant une couche market data persistante:

- `Polymarket`: market channel WebSocket + resync REST
- `Kalshi`: WebSocket quand disponible + resync orderbook/trades REST
- les snapshots affichés par le dashboard sont compactés en base chaque seconde
- aucune opportunité n’est exécutable si un feed est `degraded` ou `blocked`

## Upgrade

Avant toute mise à jour, conserver `LIVE_EXECUTION_ALLOWED=false` et vérifier qu’il ne reste aucun intent live, order attempt live ou exposition en capital non terminale. Reporter le déploiement tant que la vérité venue n’est pas réconciliée; ne pas fermer ni modifier ces lignes directement en base. Cette précondition est impérative lorsqu’une version change la génération des client order IDs, car un processus ancien et un processus nouveau ne doivent pas reprendre la même soumission avec des identifiants différents.

Après un `git pull --ff-only` propre effectué en tant que `warbitrer`, lancer:

`sudo bash deploy/vps/deploy.sh`

Le script corrigé:

1. refuse un working tree sale
2. exige un fichier d’environnement lisible
3. exécute un premier préflight avec l’exécution live désactivée
4. arrête le web et les sept services de worker, puis rejoue le préflight pour fermer la course avec l’arrêt
5. crée et attend un backup Postgres cohérent pendant que l’application est arrêtée
6. exécute audit, lint, format, typecheck, tests et les deux builds
7. applique les migrations versionnées V1-V9, exige un `db:status` prêt, puis rejoue le préflight
8. redémarre et vérifie les huit services applicatifs ainsi que le timer de backup

Il ne lance pas `git pull` et ne remplace pas les contrôles opérateur préalables. Une erreur après l’arrêt laisse les services applicatifs arrêtés afin d’éviter une reprise sur un état non validé.

Pour la première migration V0 vers V8 seulement, des projections historiques peuvent nécessiter le réparateur
audité `npm run db:repair-v8-legacy`. Toujours faire un dry-run puis utiliser les mêmes nombres attendus avec
`--apply`, services arrêtés, backup vérifié et `LIVE_EXECUTION_ALLOWED=false`. La table
`legacy_v8_precondition_repairs` conserve le JSON avant/après de chaque ligne corrigée.

Si les seuls défauts restants sont d’anciennes intentions terminales avec exposition comptable incertaine, elles
restent bloquantes pour toute entrée live. Le build shadow peut être déployé explicitement avec :

```bash
ALLOW_HISTORICAL_LEGACY_ACCOUNTING_DEPLOY=true sudo -E bash deploy/vps/deploy.sh
```

Cet override ne doit jamais être ajouté au fichier d’environnement et ne contourne pas le blocage comptable du
runtime.

Après un `hedge_failure`, utiliser la vue détaillée des incidents et résoudre chaque incident exact depuis l’interface ou l’API authentifiée. L’exposition doit d’abord être prouvée récupérée; ne jamais effacer globalement les breakers ni modifier leurs lignes directement en base.

## Séquence recommandée

1. démarrer avec `enableTrading=false`
2. passer à `enableTrading=true` et `shadowMode=true`
3. vérifier dashboard, intents, fills synthétiques, balances, positions
4. financer Kalshi et Polymarket
5. vérifier que les credentials et allowances sont valides
6. après validation explicite, passer à `enableTrading=true` et `shadowMode=false` puis autoriser séparément le runtime avec `LIVE_EXECUTION_ALLOWED=true`

## Ce qui doit être prêt avant le live réel

- compte Kalshi approuvé et financé
- wallet/funder Polymarket prêt
- API key L2 Polymarket valide
- allowance collateral Polymarket suffisante
- Postgres opérationnel
- `npm run db:status` prêt sur les migrations V1-V9
- `POLYGON_RPC_URL` configuré sur Polygon mainnet (chain ID 137) pour la preuve exacte des fills Polymarket
- aucune erreur dans `/api/health`
- aucun circuit breaker actif
- aucun intent, order attempt ou exposition live non terminale avant un déploiement

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
- `POLYGON_RPC_URL` doit être renseigné pour toute exécution live et pour le redeem/merge direct
- la page `/recovery` vérifie déjà si la migration EOA est techniquement prête
