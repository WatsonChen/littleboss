import { createPool } from './pool.js';
import { migrate } from './migrate.js';

/**
 * Runs at the end of a Vercel build. Only a production deploy changes the database: previews and
 * local builds skip it. A missing URL is a warning, not a failure, so the first deploy works
 * before the database is connected; a failing migration does stop the deploy.
 */
if (process.env.VERCEL_ENV !== 'production') {
  console.log(`migrations skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? 'not set'})`);
} else {
  // The direct (unpooled) connection: the pooler lacks the session features migrations use.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) {
    console.warn('migrations skipped: no DATABASE_URL_UNPOOLED / DATABASE_URL in this environment');
  } else {
    const pool = createPool(url, 1);
    try {
      const applied = await migrate(pool);
      console.log(
        applied.length ? `migrations applied: ${applied.join(', ')}` : 'migrations: up to date',
      );
    } finally {
      await pool.end();
    }
  }
}
