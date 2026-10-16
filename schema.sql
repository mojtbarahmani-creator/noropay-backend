-- ============================================================
-- NeuroPay - PostgreSQL Schema (Render Postgres compatible)
-- ============================================================

-- Enums
CREATE TYPE user_role AS ENUM ('driver', 'agent', 'admin');
CREATE TYPE tx_type AS ENUM ('topup', 'payment');
CREATE TYPE tx_status AS ENUM ('pending', 'completed', 'failed', 'reversed');
CREATE TYPE tx_method AS ENUM ('cash', 'card', 'agent', 'app', 'qr');

-- Users
CREATE TABLE IF NOT EXISTS users (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone        VARCHAR(20) UNIQUE NOT NULL,
    full_name    VARCHAR(120) NOT NULL,
    role         user_role NOT NULL DEFAULT 'driver',
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Driver profiles
CREATE TABLE IF NOT EXISTS driver_profiles (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    driver_code  VARCHAR(16) UNIQUE NOT NULL,
    vehicle_plate VARCHAR(20),
    city         VARCHAR(60),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Wallets
CREATE TABLE IF NOT EXISTS wallets (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id    UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    balance      NUMERIC(14, 2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
    currency     VARCHAR(3) NOT NULL DEFAULT 'IRR',
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Transactions (append-only ledger)
CREATE TABLE IF NOT EXISTS transactions (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_id    UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    driver_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type         tx_type NOT NULL,
    amount       NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    method       tx_method NOT NULL DEFAULT 'app',
    reference    VARCHAR(120),
    nonce        VARCHAR(64),
    status       tx_status NOT NULL DEFAULT 'completed',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nonce registry (anti double-spend / replay protection)
CREATE TABLE IF NOT EXISTS used_nonces (
    id           BIGSERIAL PRIMARY KEY,
    nonce        VARCHAR(64) UNIQUE NOT NULL,
    wallet_id    UUID REFERENCES wallets(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_tx_wallet_created   ON transactions (wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_driver_created   ON transactions (driver_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tx_nonce            ON transactions (nonce);
CREATE INDEX IF NOT EXISTS idx_driver_code         ON driver_profiles (driver_code);
CREATE INDEX IF NOT EXISTS idx_nonces_created      ON used_nonces (created_at);

-- updated_at trigger
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated ON users;
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_wallets_updated ON wallets;
CREATE TRIGGER trg_wallets_updated BEFORE UPDATE ON wallets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- Seed demo data
-- ============================================================
INSERT INTO users (phone, full_name, role) VALUES
    ('09120000001', 'علی رضایی', 'driver'),
    ('09120000002', 'محمد کریمی', 'driver'),
    ('09120000003', 'سارا احمدی', 'agent')
ON CONFLICT (phone) DO NOTHING;

INSERT INTO driver_profiles (user_id, driver_code, vehicle_plate, city)
SELECT u.id, 'NP-' || LPAD(ROW_NUMBER() OVER (ORDER BY u.created_at)::text, 5, '0'), '12ب345-ایران', 'تهران'
FROM users u WHERE u.role = 'driver'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO wallets (driver_id, balance)
SELECT u.id, 500000.00 FROM users u WHERE u.role = 'driver'
ON CONFLICT (driver_id) DO NOTHING;

-- Demo transaction
INSERT INTO transactions (wallet_id, driver_id, type, amount, method, status)
SELECT w.id, w.driver_id, 'topup', 500000.00, 'cash', 'completed'
FROM wallets w
WHERE NOT EXISTS (SELECT 1 FROM transactions);
