import { pool } from './db.js';

export const MIGRATE_V1_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT UNIQUE NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  current_device_id TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id TEXT UNIQUE NOT NULL,
  type TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS credits (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  tg_user_id BIGINT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', -- active|used|expired|revoked
  issued_reason TEXT NOT NULL,           -- problem|feedback|promo|loyalty
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  credit_id INT NOT NULL REFERENCES credits(id),
  device_id TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT now(),
  result TEXT NOT NULL                  -- success|denied|error
);
CREATE TABLE IF NOT EXISTS feedback (
  id BIGSERIAL PRIMARY KEY,
  tg_user_id BIGINT NOT NULL,
  device_id TEXT,
  rating TEXT,
  reason TEXT,
  message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_tg_user_id ON feedback (tg_user_id);
CREATE INDEX IF NOT EXISTS idx_feedback_device_id ON feedback (device_id);
CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback (created_at);

`;

export async function runMigrateV1() {
  // --- MIGRATE: feedback table (D1) ---
  const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_DB;
  if (!DB_URL) throw new Error('Missing env: DATABASE_URL');
  await pool.query(MIGRATE_V1_SQL);
  return true;
}