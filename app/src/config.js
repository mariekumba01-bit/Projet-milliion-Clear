'use strict';
// Configuration ClearMatch App — tout passe par l'environnement (12-factor).
// Aucun secret par défaut en production : fail-fast si NODE_ENV=production et clés absentes.
// deriveFromEnv() relit l'environnement : les tests qui bootent plusieurs serveurs avec
// des variables différentes réalignent l'objet vivant (cache de module ES).

const req = (name) => process.env[name] ?? '';
const hex64 = (s) => /^[0-9a-f]{64}$/i.test(s);

export function deriveFromEnv() {
  const NODE_ENV = req('NODE_ENV') || 'development';
  const APP_SECRET_KEY = req('APP_SECRET_KEY');
  const ADMIN_TOKEN = req('ADMIN_TOKEN');

  if (NODE_ENV === 'production') {
    if (!hex64(APP_SECRET_KEY)) {
      throw new Error('APP_SECRET_KEY manquante ou invalide (hex 64) — générez avec `openssl rand -hex 32`');
    }
    if (!ADMIN_TOKEN) {
      throw new Error('ADMIN_TOKEN manquant — requis en production pour /api/admin/scheduler/tick');
    }
  } else if (!hex64(APP_SECRET_KEY)) {
    console.warn('[config] APP_SECRET_KEY non définie : clé de dev fixe utilisée — NE PAS déployer ainsi');
  }

  return {
    env: NODE_ENV,
    port: Number(req('PORT')) || 8080,
    databaseUrl: req('DATABASE_URL') || 'pglite:./data/pglite',
    appSecretKey: hex64(APP_SECRET_KEY) ? APP_SECRET_KEY : '00'.repeat(32),
    adminToken: ADMIN_TOKEN,
    billingEnforce: req('BILLING_ENFORCE') !== '0',

    saspay: {
      apiKey: req('SASPAY_API_KEY'),
      baseUrl: req('SASPAY_BASE_URL') || 'https://api.saspay.me',
      webhookSecret: req('SASPAY_WEBHOOK_SECRET'),
    },

    pennylane: {
      clientId: req('PENNYLANE_CLIENT_ID'),
      clientSecret: req('PENNYLANE_CLIENT_SECRET'),
      redirectBase: req('PENNYLANE_REDIRECT_BASE') || 'http://localhost:8080',
      authUrl: req('PENNYLANE_AUTH_URL') || 'https://app.pennylane.com/oauth/authorize',
      tokenUrl: req('PENNYLANE_TOKEN_URL') || 'https://app.pennylane.com/oauth/token',
      revokeUrl: req('PENNYLANE_REVOKE_URL') || 'https://app.pennylane.com/oauth/revoke',
      apiUrl: req('PENNYLANE_API_URL') || 'https://app.pennylane.com/api/external/v2',
      // Scopes vérifiés sur pennylane.readme.io/docs/v2-scopes (format « ressource:readonly »)
      scopes: 'customer_invoices:readonly transactions:readonly customers:readonly bank_accounts:readonly',
    },

    // Seuils du moteur de référence (benchmark.config.json, inchangés)
    engine: { feeGapMaxCents: 800, deductionHintMaxRatio: 0.15, dateWindowDays: 45 },
  };
}

export const config = deriveFromEnv();
export const isProd = config.env === 'production';
