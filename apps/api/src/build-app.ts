import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serve } from 'inngest/fastify';
import { HealthResponse } from '@littleboss/shared';
import { inngest } from './inngest/client.js';
import { ping } from './inngest/functions.js';
import { createPool, type Pool } from './db/pool.js';
import { createAiCallFunction } from './discussion/inngest.js';
import { createDiscussionService, type DiscussionService } from './discussion/index.js';
import { HttpError } from './discussion/errors.js';
import { registerDiscussionRoutes } from './discussion/routes.js';
import { createRunFunctions } from './runs/engine.js';
import { createRunService, type RunService } from './runs/index.js';
import { registerRunRoutes } from './runs/routes.js';

export interface BuildAppOptions {
  /** Inject a ready service (tests). Otherwise one is created lazily from DATABASE_URL. */
  discussion?: DiscussionService;
  runs?: RunService;
  env?: Record<string, string | undefined>;
}

export function buildApp(opts: BuildAppOptions = {}) {
  const env = opts.env ?? process.env;
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // Browser access is limited to the configured web origin(s); comma-separated.
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  void app.register(cors, {
    origin: origins,
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization'],
  });

  app.get('/health', async () => {
    const body: HealthResponse = {
      ok: true,
      service: 'littleboss-api',
      time: new Date().toISOString(),
    };
    return HealthResponse.parse(body);
  });

  // The database and the discussion service are only created when first needed, so the health
  // check and Inngest sync keep working while the database is not configured yet.
  let service = opts.discussion;
  let runService = opts.runs;
  let pool: Pool | undefined;
  const getPool = (): Pool => {
    if (pool) return pool;
    if (!env.DATABASE_URL) {
      throw new HttpError(503, 'database_not_configured', 'The database is not connected yet.');
    }
    pool = createPool(env.DATABASE_URL);
    return pool;
  };
  const getService = (): DiscussionService => {
    if (service) return service;
    service = createDiscussionService(env, getPool());
    return service;
  };
  const getRuns = (): RunService => {
    if (runService) return runService;
    runService = createRunService(env, getPool());
    return runService;
  };
  app.addHook('onClose', async () => {
    await pool?.end();
  });
  registerDiscussionRoutes(app, getService, env, (api) => registerRunRoutes(api, getRuns));

  // Checks the database connection without exposing anything but whether it works and how fast.
  app.get('/health/db', async (_req, reply) => {
    const started = Date.now();
    try {
      const db = getService().db();
      await db.query('select 1');
      return {
        ok: true,
        latencyMs: Date.now() - started,
        migrations: await db.countMigrations(),
      };
    } catch (err) {
      const code =
        err instanceof HttpError ? err.code : ((err as { code?: string }).code ?? 'db_error');
      return reply.status(503).send({ ok: false, error: String(code) });
    }
  });

  // Inngest calls this endpoint to sync and to run steps; requests are verified with the signing key.
  app.route({
    method: ['GET', 'POST', 'PUT'],
    url: '/api/inngest',
    handler: serve({ client: inngest, functions: [ping, createAiCallFunction(getService), ...createRunFunctions(getRuns)] }),
  });

  return app;
}
