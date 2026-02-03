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
`;

export async function runMigrateV1() {
  const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_DB;
  if (!DB_URL) throw new Error('Missing env: DATABASE_URL');
  await pool.query(MIGRATE_V1_SQL);
  return true;
}
