# EOA Runbook

Ce runbook prepare la migration future `POLY_PROXY -> EOA`.

## Objectif

Permettre:

- redeem direct Polymarket depuis l’app
- auto-redeem futur
- réutilisation rapide du collateral après resolution

## Variables requises

```env
POLY_SIGNATURE_TYPE=EOA
POLY_PRIVATE_KEY_PATH=/etc/warbitrer/polymarket-private-key.txt
POLY_FUNDER_ADDRESS=0xTON_ADRESSE_PUBLIQUE_EOA
POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/...
```

Le fichier `/etc/warbitrer/polymarket-private-key.txt` doit contenir uniquement:

```text
0xTON_HEX_PRIVATE_KEY
```

## Credentials L2

Une fois le signer/funder EOA configuré:

```bash
cd /opt/warbitrer-live/app
npm run poly:derive-api-key
```

Copier ensuite dans `/etc/warbitrer/warbitrer.env`:

- `POLY_API_KEY`
- `POLY_API_SECRET`
- `POLY_API_PASSPHRASE`

Puis:

```bash
sudo systemctl restart warbitrer-web warbitrer-worker
```

## Important

Changer `POLY_PROXY` en `EOA` dans l’env ne déplace pas les positions existantes.

- si tes fonds/positions actuels sont sur le proxy Polymarket, ils y restent
- la migration EOA doit être faite avec un wallet de trading/funding cohérent
- la page `/recovery` affiche déjà les checks bloquants avant toute bascule
