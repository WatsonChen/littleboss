import pg from 'pg';

/**
 * One pool per process. On Vercel (serverless) use the pooled Neon URL here; migrations use the
 * direct URL (see migrate.ts) because the pooler lacks session features.
 */
export function createPool(connectionString: string, max = 5): pg.Pool {
  return new pg.Pool({ connectionString, max });
}

export type Pool = pg.Pool;
