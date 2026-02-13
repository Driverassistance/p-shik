import { pool } from './db.js';

/**
 * Миграции v1:
 * - idempotent: можно запускать много раз
 * - без q(): только pool.query()
 * - с фиксацией версии в schema_migrations
 */

const MIGRATE_V1_SQL = `
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  tg_user_id BIGINT UNIQUE NOT NULL,
  first_seen_at TIMESTAMPTZ DEFAULT now(),
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  current_device_id TEXT
);

-- DEVICES
CREATE TABLE IF NOT EXISTS devices (
  id SERIAL PRIMARY KEY,
  device_id TEXT UNIQUE NOT NULL,
  type TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- CREDITS (сервисные коды)
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

-- REDEMPTIONS (погашения кодов)
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  credit_id INT NOT NULL REFERENCES credits(id),
  device_id TEXT NOT NULL,
  redeemed_at TIMESTAMPTZ DEFAULT now(),
  result TEXT NOT NULL                  -- success|denied|error
);

-- FEEDBACK (отзывы + сообщения)
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

COMMIT;
`;

const MIGRATE_V2_SQL = `
BEGIN;

-- USER_STATE (state manager)
CREATE TABLE IF NOT EXISTS user_state (
  tg_user_id BIGINT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'idle',
  payload JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_state_state ON user_state (state);
CREATE INDEX IF NOT EXISTS idx_user_state_updated_at ON user_state (updated_at);

COMMIT;
`;

export async function runMigrateV2() {
  await ensureEnv();

  // schema_migrations должна существовать до проверки версии
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const version = 'v2';
  if (await hasMigration(version)) return true;

  await pool.query(MIGRATE_V2_SQL);
  await markMigration(version);
  return true;
}

async function ensureEnv() {
  const DB_URL = process.env.DATABASE_URL || process.env.POSTGRES_DB;
  if (!DB_URL) throw new Error('Missing env: DATABASE_URL');
}

async function hasMigration(version: string): Promise<boolean> {
  const r = await pool.query(
    'SELECT 1 FROM schema_migrations WHERE version=$1 LIMIT 1',
    [version]
  );
  return (r.rows?.length ?? 0) > 0;
}

async function markMigration(version: string) {
  await pool.query(
    'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT (version) DO NOTHING',
    [version]
  );
}

export async function runMigrateV1() {
  await ensureEnv();

  // schema_migrations должна существовать до проверки версии
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  const version = 'v1';
  if (await hasMigration(version)) return true;

  await pool.query(MIGRATE_V1_SQL);
  await markMigration(version);
  return true;
}

/**
 * CLI entry (npm run migrate)
 */
export async function main() {
  try {
    const ok = await runMigrateV1();
    if (ok) console.log('✅ migrate v1 ok');
    process.exit(0);
  } catch (e: any) {
    console.error('❌ migrate failed', e);
    process.exit(1);
  }
}

// Если файл запущен напрямую: node dist/migrate.js
if (process.argv[1] && /migrate(\.js)?$/i.test(process.argv[1])) {
  // eslint-disable-next-line @typescript-eslint/no-floating-promises
  main();
}
