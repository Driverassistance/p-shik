import { pool } from './db.js';

const sql = `
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

async function main() {
  if (!process.env.DATABASE_URL) throw new Error('Missing env: DATABASE_URL');
  await pool.query(sql);
  console.log('✅ migrate v1 ok');
  await pool.end();
}

main().catch((e) => {
  console.error('❌ migrate failed', e);
  process.exit(1);
});
