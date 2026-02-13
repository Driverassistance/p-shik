import { Pool } from 'pg';

function needsSsl(conn?: string) {
  if (!conn) return false;

  try {
    const u = new URL(conn);
    const host = (u.hostname || '').toLowerCase();

    // Local Postgres обычно без SSL
    if (host === 'localhost' || host === '127.0.0.1') return false;

    // Remote (Railway/Cloud) — SSL нужен
    return true;
  } catch {
    // если строка не парсится как URL — не включаем SSL
    return false;
  }
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

export async function q<T = any>(text: string, params?: any[]) {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
