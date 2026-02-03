import { Pool } from 'pg';

function needsSsl(conn?: string) {
  return !!conn && !conn.includes('railway.internal');
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: needsSsl(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : undefined,
});

export async function q<T = any>(text: string, params?: any[]) {
  const res = await pool.query(text, params);
  return res.rows as T[];
}
