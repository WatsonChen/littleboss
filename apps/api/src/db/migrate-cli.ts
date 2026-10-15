import { createPool } from './pool.js';
import { migrate } from './migrate.js';

// Use the DIRECT (unpooled) connection string for migrations.
const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
if (!url) {
  console.error('Set DATABASE_URL_UNPOOLED (or DATABASE_URL) to run migrations.');
  process.exit(1);
}
const pool = createPool(url, 1);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await pool.end();
}
