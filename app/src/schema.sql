-- ClearMatch App — schéma v1 (idempotent). Tous les montants sont en centimes entiers
-- (comptabilité) ou en FCFA entiers (liens SasPay). Isolation par company_id partout.

CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY, value text NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id serial PRIMARY KEY,
  email text NOT NULL UNIQUE,
  email_lc text NOT NULL UNIQUE,          -- normalisé minuscules pour l'unicité réelle
  password_hash text NOT NULL,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id serial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,        -- sha256 du jeton : la base ne contient jamais le jeton
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id serial PRIMARY KEY,
  name text NOT NULL,
  owner_user_id integer NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'owner' CHECK (role IN ('owner', 'accountant', 'viewer')),
  PRIMARY KEY (company_id, user_id)
);

-- Portefeuille : source = manual | demo | pennylane ; (company_id, source, external_id) unique = ré-import idempotent
CREATE TABLE IF NOT EXISTS invoices (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  number text NOT NULL,
  customer text NOT NULL,
  customer_reference text,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  currency text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  issue_date date NOT NULL,
  due_date date NOT NULL,
  open boolean NOT NULL DEFAULT true,
  UNIQUE (company_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_company ON invoices(company_id, open);

CREATE TABLE IF NOT EXISTS payments (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'manual',
  external_id text,
  label text NOT NULL,
  amount_cents integer NOT NULL,          -- signé : négatif = rejet/annulation
  currency text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  date date NOT NULL,
  UNIQUE (company_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_company ON payments(company_id);

-- Exceptions : résultat du moteur + décision HUMAINE (jamais d'écriture automatique)
CREATE TABLE IF NOT EXISTS exceptions (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  payment_row_id integer NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK (decision IN ('proposal', 'flag', 'abstain')),
  classification text NOT NULL,
  result jsonb NOT NULL,                  -- EngineResult complet (preuves comprises)
  status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'validated', 'rejected')),
  decided_by integer REFERENCES users(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exceptions_company ON exceptions(company_id, status);

-- Journal d'audit chaîné par entreprise : hash = sha256(seq|prev|kind|payload|ts)
CREATE TABLE IF NOT EXISTS audit_events (
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  kind text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  prev_hash text NOT NULL,
  hash text NOT NULL,
  ts timestamptz NOT NULL,
  PRIMARY KEY (company_id, seq)
);

-- Écritures proposées générées à la validation humaine (jamais postées automatiquement)
CREATE TABLE IF NOT EXISTS journal_entries (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  exception_id integer NOT NULL REFERENCES exceptions(id) ON DELETE CASCADE,
  lines jsonb NOT NULL,                   -- [{account, label, debit, credit}]
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Abonnements : modèle « lien de paiement par mois » (SasPay, pas de prélèvement natif)
CREATE TABLE IF NOT EXISTS subscriptions (
  id serial PRIMARY KEY,
  company_id integer NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan text NOT NULL CHECK (plan IN ('starter', 'pro', 'cabinet')),
  status text NOT NULL DEFAULT 'pending_payment'
    CHECK (status IN ('none', 'pending_payment', 'active', 'past_due', 'suspended', 'canceled')),
  period_month text NOT NULL,             -- 'YYYY-MM'
  due_date date NOT NULL,                 -- échéance de suspension (jour 21 du mois)
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payment_links (
  id serial PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id integer NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  period_month text NOT NULL,
  amount_fcfa integer NOT NULL CHECK (amount_fcfa > 0),
  mode text NOT NULL DEFAULT 'manual' CHECK (mode IN ('saspay', 'manual')),
  saspay_id text,
  url text,
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'candidate', 'paid', 'canceled')),
  paid_transaction_ref text,              -- identifiant de transaction consommé (antifraude)
  reminder_sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz,
  UNIQUE (subscription_id, period_month)
);
-- Un identifiant de transaction ne peut payer qu'un seul lien, jamais deux.
CREATE UNIQUE INDEX IF NOT EXISTS uq_paid_transaction_ref
  ON payment_links (paid_transaction_ref) WHERE paid_transaction_ref IS NOT NULL;

-- Webhooks SasPay : idempotence par id d'événement (PK) — jamais traité deux fois
CREATE TABLE IF NOT EXISTS saspay_events (
  id text PRIMARY KEY,                    -- id de l'événement fournisseur
  event text NOT NULL,
  payload jsonb NOT NULL,
  signature_ok boolean NOT NULL,
  processed_at timestamptz,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- OAuth Pennylane : états anti-CSRF jetables + jetons chiffrés AES-256-GCM au repos
CREATE TABLE IF NOT EXISTS oauth_states (
  state text PRIMARY KEY,
  company_id integer NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pennylane_connections (
  company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  access_token_enc text NOT NULL,
  refresh_token_enc text NOT NULL,
  access_expires_at timestamptz NOT NULL,
  refresh_expires_at timestamptz,         -- 90 jours, rotation stricte à chaque refresh
  status text NOT NULL DEFAULT 'connected',
  updated_at timestamptz NOT NULL DEFAULT now()
);
