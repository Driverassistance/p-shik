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
  const sqlText = typeof text === 'string' ? text : String(text ?? '');
  // Быстрый детектор: какой максимальный $N в запросе
  const matches = sqlText.match(/\$(\d+)/g) || [];
  let maxN = 0;
  for (const m of matches) {
    const n = Number(m.slice(1));
    if (n > maxN) maxN = n;
  }
  const got = params?.length ?? 0;

  if (maxN !== got) {
    console.error('[DB] PARAM_MISMATCH', {
      maxPlaceholders: maxN,
      gotParams: got,
      text: sqlText,      params,
    });
    // чтобы сразу было видно в логах и стек не был “левый”
    throw new Error(`DB_PARAM_MISMATCH expected=${maxN} got=${got}`);
  }

  try {
    const res = await pool.query(sqlText, params);
    return res.rows as T[];
  } catch (e: any) {
    console.error('[DB] query failed:', { text: sqlText, params, err: e?.message });
    throw e;
  }
}
