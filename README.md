# Paper BTC 15m Arb

Dashboard paper-only pour suivre les opportunités BTC 15 minutes entre Polymarket et Kalshi.

## Stockage

- Si `DATABASE_URL` est défini, l'app utilise **Postgres**.
- Sinon, elle retombe automatiquement sur **SQLite local** dans `data/paper-arb.db`.

## Local

Pré-requis: **Node 22+**.

1. `npm install`
2. `npm run dev:all`
3. Ouvrir `http://localhost:3000`

Le web et le worker tournent en parallèle.

## GitHub: commit + push

1. `git init` si le repo n'existe pas encore localement.
2. `git add .`
3. `git commit -m "Add BTC 15m paper arb dashboard"`
4. Créer le repo distant sur GitHub.
5. `git remote add origin <URL_DU_REPO_GITHUB>`
6. `git branch -M main`
7. `git push -u origin main`

## Railway

Le repo est prêt pour un déploiement Railway avec `railway.toml`.

Recommandé:

1. Créer un projet Railway depuis le repo GitHub.
2. Ajouter un service **Postgres** dans Railway.
3. Vérifier que `DATABASE_URL` est bien injecté dans le service applicatif.
4. Déployer.

## Variables d'environnement

- `DATABASE_URL`:
  - si défini, le stockage passe automatiquement sur Postgres.
  - en local, une URL `localhost` est normale.
  - sur Railway, il faut utiliser la variable injectée par le service Postgres Railway, pas `localhost`.
- `PAPER_ARB_DB_PATH`:
  - optionnel en local si tu veux forcer un chemin SQLite.

## Railway: mise en place détaillée

1. Push le repo sur GitHub.
2. Dans Railway, cliquer sur `New Project`.
3. Choisir `Deploy from GitHub repo`.
4. Sélectionner ce repo.
5. Dans le projet Railway, ajouter `Postgres` via `New > Database > Add PostgreSQL`.
6. Ouvrir le service de l'app puis vérifier dans `Variables` que `DATABASE_URL` pointe bien vers la base Railway.
7. Laisser Railway builder avec Nixpacks; `railway.toml` lance déjà:
   - build: `npm run build`
   - run: `npm run start:all`
8. Déclencher un déploiement.
9. Ouvrir le domaine Railway généré dans `Settings > Networking`.

Le worker et le site tournent dans le même service en production. La persistance est donc portée par Postgres, pas par le filesystem du conteneur.
Le projet déclare aussi `Node 22+` dans `package.json`, ce qui aide Railway à prendre une version compatible.

Le service web et le worker prod démarrent ensemble via `npm run start:all`.

## Notes

- L'endpoint healthcheck est `GET /api/health`.
- Railway rendra l'app visible via son domaine public après le déploiement.
