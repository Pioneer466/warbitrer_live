# Handoff – Guardrails / Safeguards / Portfolio UI / Runtime status

## Contexte général

Projet `warbitrer-live` de trading/arbitrage multi-assets entre **Kalshi** et **Polymarket** sur marchés directionnels courts (`UP/DOWN 15m`).

Le focus récent a été :

1. stabilisation runtime du worker
2. refonte UI du portfolio
3. réduction du risque de mismatch d’outcome Kalshi vs Polymarket
4. évolution progressive vers des guardrails plus pertinents

Le thread précédent a planté plusieurs fois à cause de la compaction de contexte Cursor/Codex.  
Le but de ce document est de reprendre proprement avec un focus sur les guardrails.

---

# 1. État global de l’application

## Déploiement VPS

Tout est OK :

- git pull OK  
- npm ci OK  
- typecheck OK  
- tests OK  
- build OK  
- worker + web OK

Routes présentes :

- /api/dashboard  
- /api/dashboard/[asset]  
- /api/health  
- /api/history/current-slot  
- /api/settings  
- /api/settings/[asset]  
- /api/trades  
- /btc /eth /sol /xrp

👉 App fonctionnelle

---

# 2. Problème runtime (worker)

## Symptôme

Warning récurrent :

MaxListenersExceededWarning sur TLSSocket

## Diagnostic

- pas de crash
- mais surcharge réseau
- accumulation de listeners

## Causes probables

- polling trop fréquent  
- resync REST agressif  
- refresh balances/positions répétés

## Correctifs appliqués

- mutualisation balances (1x par tick)
- mutualisation positions
- ralentissement REST
- REST en fallback uniquement

## Statut

✔ implémenté  
❗ à vérifier en prod (logs)

---

# 3. UI Portfolio

## Objectif

UI lisible + sobre

## Résultat attendu

- encadrés noirs
- texte blanc
- couleurs seulement pour :
  - asset
  - mode
  - readiness
  - WATCH / ELIGIBLE
- suppression net projeté
- suppression meilleur brut
- idle discret

## Statut

✔ implémenté  
❗ à vérifier visuellement

---

# 4. Guardrails (PARTIE CRITIQUE)

---

## 4.1 Problème métier

Mismatch = Kalshi ≠ Polymarket

Causes :

- CF Benchmark vs Chainlink  
- prix open différents  
- near-zero moves

👉 risque majeur

---

## 4.2 Plan initial

### Layer 1

- alignement direction
- minimum move threshold
- spread tracking

### Layer 2

- divergence trigger
- momentum check

### Layer 3

- position sizing

### Layer 4

- timing entrée tardif

👉 clé = minimum move threshold

---

## 4.3 Implémentation v1

### Ajouts

- mismatchGuardEnabled
- mismatchGuardMinElapsedSeconds
- mismatchGuardMaxVenueDisagreementPct

### Champs

- mismatchRisk
- venueDisagreementPct
- secondsElapsedInSlot

### Logique

basée sur :

différence de prix entre venues

---

## 4.4 Audit v1

### Problème majeur

❌ ne mesure PAS le vrai mismatch

manque :

- move depuis open
- direction benchmark
- filtre near-zero

### Autres problèmes

- incohérence par combo
- pas visible UI
- pas de tests

### Verdict

❌ insuffisant  
✔ heuristique seulement

---

## 4.5 Blocage

Accès benchmarks :

- CF → payant
- Chainlink → limité

---

## 4.6 Données disponibles

### Kalshi

✔ open target  
❌ live benchmark

### Polymarket

✔ websocket chainlink  
❌ priceToBeat fiable

---

## 4.7 Nouvelle stratégie (v2)

Proxy guard basée sur :

- Kalshi open
- Polymarket chainlink live
- snapshot open slot

### Objectif

guard slot-level basé sur :

- temps écoulé
- move réel
- désaccord venues

---

## 4.8 Implémentation v2 (EN COURS)

### Fichiers touchés

- constants.ts
- kalshi.ts
- market-catalog.ts
- market-data.ts
- polymarket.ts
- settings-schema.ts
- signals.ts
- types.ts

### Changements

- ajout RTDS
- snapshot open
- guard par slot
- suppression incohérences

---

# 5. État actuel

## Fait

✔ design correct  
✔ implémentation partielle  

## Probable

⚠ code incomplet  
⚠ tests non alignés  
⚠ UI pas branchée  

## Non garanti

- compile OK
- tests OK
- affichage OK
- déploiement OK

---

# 6. Prochaines étapes

## PRIORITÉ

finaliser v2 (ne pas refaire)

### Étapes

1. audit repo
2. typecheck / test / build
3. corriger tests
4. brancher UI
5. vérifier logique slot-level

---

# 7. Mission Codex

Faire :

1. audit complet
2. classifier :
  - fait
  - partiel
  - cassé
3. finaliser uniquement ce qui manque
4. valider build + tests
5. produire bilan final

---

# ⚡ TL;DR

- app OK
- worker amélioré (à vérifier)
- UI OK
- guardrails = chantier principal

👉 v1 = insuffisante  
👉 v2 = en cours mais non finalisée  

👉 priorité = finir v2 proprement