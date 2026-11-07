# ClearMatch App — l'application commerciale du moteur de référence

Backend **réel** construit au-dessus du banc d'essai du dépôt (moteur v0.2 gardé intact) :
multi-entreprises, PostgreSQL, authentification, Pennylane OAuth2, encaissement SasPay,
abonnements « lien par mois », journal d'audit chaîné, décisions humaines obligatoires.

**Ce qui est réel maintenant** : tout le parcours produit — comptes, espaces isolés par
entreprise, import de portefeuille, analyse du moteur, validation humaine avec écritures
proposées, audit vérifiable cryptographiquement, abonnements avec cycle J1/J7/J21, webhooks
SasPay vérifiés à temps constant et idempotents, OAuth2 Pennylane complet (code + refresh à
rotation stricte, jetons chiffrés AES-256-GCM). Couvert par la suite de tests (moteur,
sécurité, facturation, tenancy, OAuth, E2E complet).

**Ce qui reste à activer avec des credentials réels** (le code est prêt, les appels partent
au jour J) :
- SasPay : `SASPAY_API_KEY` → création réelle de liens `POST /payment-links/`. Sans clé,
  les liens sont créés en **mode manuel** (jamais simulés comme payés). Webhooks à créer
  depuis le tableau de bord SasPay vers `/api/webhooks/saspay`.
- Pennylane : `PENNYLANE_CLIENT_ID/SECRET` (accès partenaire, partnerships@pennylane.com)
  → flow OAuth réel vers app.pennylane.com + sync factures/transactions (API externe v2).
- Emails/WhatsApp des rappels J7 : file d'envoi à brancher (les événements sont scellés
  au journal d'audit, l'envoi reste à implémenter).
- Convention de signe des montants Pennylane (débit/crédit) : à confirmer en pilote
  (la doc ne la précise pas ; transmise telle quelle au moteur).

## Démarrage

```bash
npm install
npm start                    # PostgreSQL embarqué (pglite) — dev/tests uniquement
open http://localhost:8080
```

Production (PostgreSQL serveur) :

```bash
export DATABASE_URL=postgres://user:pass@host:5432/clearmatch
export APP_SECRET_KEY=$(openssl rand -hex 32)   # obligatoire en production
export ADMIN_TOKEN=$(openssl rand -hex 24)      # cron du scheduler
npm start
```

Docker (app + PostgreSQL 16) :

```bash
docker compose up --build
```

## Tests (tout le comportement ci-dessus, vérifié automatiquement)

```bash
npm test                     # moteur, auth/CSRF/rate-limit, webhooks, abonnements, tenancy, OAuth
npm run e2e                  # parcours utilisateur complet, HTTP réel, de l'inscription à la réactivation
```

## Architecture

```
src/
  config.js            environnement 12-factor (fail-fast en production)
  db.js                PostgreSQL dual : pg (serveur) / pglite (dev/test, vrai moteur SQL)
  schema.sql           v1 : users, sessions, companies, invoices/payments, exceptions,
                       audit_events (chaîne), journal_entries, subscriptions/payment_links,
                       saspay_events (idempotence), oauth_states, pennylane_connections
  util.js              scrypt, sha256, HMAC, comparaison à temps constant, AES-256-GCM
  auth.js              sessions HttpOnly SameSite=Strict, CSRF origine, rate-limit
  audit.js             journal chaîné sha256(seq|prev|kind|payload|ts), genesis partagé
  engine/core.js       port fidèle du moteur v0.2 (sans DOM ni données démo)
  engine/service.js    moteur sur données réelles, décisions humaines finales, écritures
  billing.js           J1 lien / J7 rappel / J21 suspension, webhooks idempotents
  integrations/saspay.js     port de connector-saspay.ts + client réseau réel
  integrations/pennylane.js  OAuth2 v2 réel, mappers champs vérifiés, sync paginée
  routes.js            toutes les routes /api
  server.js            node:http brut, erreurs enveloppées, logs JSON
  public/index.html    UI single-file (inscription → tableau de bord → abonnement)
```

## Contrat produit (inchangé)

- **Jamais d'écriture automatique** : le moteur propose, un humain valide (`requiresHuman: true`),
- **0 appel LLM** : moteur déterministe, mêmes seuils que la référence (écart de frais 800 c,
  déductions 0.15, fenêtre 45 j),
- **Preuves à chaque décision** : journal d'audit chaîné par entreprise, vérifiable d'un clic,
- **Prix** : hypothèses de test (Starter 49 €, Pro 149 €, Cabinet 399 € ; FCFA à parité fixe
  655,957 arrondi au 500) — non validés commercialement.

## Ordonnanceur (J1/J7/J21)

En production, appeler quotidiennement (cron) :

```bash
curl -X POST https://…/api/admin/scheduler/tick -H "x-admin-token: $ADMIN_TOKEN"
```

Ou lancer le conteneur avec `SCHEDULER_INTERVAL_SECONDS=3600` pour un tick horaire interne.

## Limites honnêtes (pilotage)

Les 114 cas et 8 461 opérations du banc d'essai prouvent la conformité du moteur à SES
règles, pas la précision sur données réelles : la phase 6 (pilote, données autorisées)
reste le seul juge. Les scores de confiance du moteur sont des heuristiques codées, pas
des probabilités calibrées — la calibration est une étape du pilote.
