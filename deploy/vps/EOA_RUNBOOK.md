# EOA Runbook

Ce runbook prepare la migration future `POLY_PROXY -> EOA`.

Si ton compte Polymarket principal est en `Google / Magic Link`, garde d'abord `POLY_SIGNATURE_TYPE=POLY_PROXY` et utilise une `POLY_RELAYER_API_KEY` pour la conversion gasless.

## Objectif

Permettre:

- redeem direct Polymarket depuis l’app
- merge direct des full sets YES/NO depuis l’app
- auto-conversion future `redeem + merge`
- réutilisation rapide du collateral après resolution

## Variables requises

```env
POLY_SIGNATURE_TYPE=EOA
POLY_PRIVATE_KEY_PATH=/etc/warbitrer/polymarket-private-key.txt
POLY_FUNDER_ADDRESS=0xTON_ADRESSE_PUBLIQUE_EOA
POLY_AUTO_CONVERT=true
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
```

En mode `POLY_PROXY` actuel, la variante minimale est:

```env
POLY_SIGNATURE_TYPE=POLY_PROXY
POLY_PRIVATE_KEY_PATH=/etc/warbitrer/polymarket-private-key.txt
POLY_FUNDER_ADDRESS=0xTON_PROXY_WALLET_POLYMARKET
POLY_RELAYER_API_KEY=...
POLY_RELAYER_URL=https://relayer-v2.polymarket.com
POLY_AUTO_CONVERT=true
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
```

Le fichier `/etc/warbitrer/polymarket-private-key.txt` doit contenir uniquement:

```text
0xTON_HEX_PRIVATE_KEY
```

## Credentials L2

Une fois le signer/funder EOA configuré:

- conserver `LIVE_EXECUTION_ALLOWED=false`
- mettre tous les actifs en scan-only
- vérifier qu’aucun intent, order attempt ou exposition live n’est non terminal
- terminer la réconciliation venue avant de changer de signer ou de funder

```bash
cd /opt/warbitrer-live/app
sudo -u warbitrer -H npm run poly:derive-api-key
```

Copier ensuite dans `/etc/warbitrer/warbitrer.env`:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`

Puis:

```bash
sudo systemctl restart \
  warbitrer-web \
  warbitrer-asset@btc \
  warbitrer-asset@eth \
  warbitrer-asset@sol \
  warbitrer-asset@xrp \
  warbitrer-asset@doge \
  warbitrer-asset@bnb \
  warbitrer-asset@hype \
  warbitrer-reconciler \
  warbitrer-notifier

sudo systemctl --quiet is-active \
  warbitrer-web \
  warbitrer-asset@btc \
  warbitrer-asset@eth \
  warbitrer-asset@sol \
  warbitrer-asset@xrp \
  warbitrer-asset@doge \
  warbitrer-asset@bnb \
  warbitrer-asset@hype \
  warbitrer-reconciler \
  warbitrer-notifier
```

## Important

Changer `POLY_PROXY` en `EOA` dans l’env ne déplace pas les positions existantes.

- si tes fonds/positions actuels sont sur le proxy Polymarket, ils y restent
- la migration EOA doit être faite avec un wallet de trading/funding cohérent
- la page `/recovery` affiche déjà les checks bloquants avant toute bascule
- `POLY_AUTO_CONVERT=true` active la conversion automatique vers `USDC.e` quand une position est `redeemable` ou `mergeable`
- ne réactiver le live qu’après validation du nouveau wallet en scan/shadow et autorisation explicite via `LIVE_EXECUTION_ALLOWED=true`
