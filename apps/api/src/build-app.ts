import Fastify from 'fastify';
import cors from '@fastify/cors';
import { serve } from 'inngest/fastify';
import { HealthResponse } from '@littleboss/shared';
import { inngest } from './inngest/client.js';
import { functions } from './inngest/functions.js';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  // Browser access is limited to the configured web origin(s); comma-separated.
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  void app.register(cors, { origin: origins });

  app.get('/health', async () => {
    const body: HealthResponse = {
      ok: true,
      service: 'littleboss-api',
      time: new Date().toISOString(),
    };
    return HealthResponse.parse(body);
  });

  // Inngest calls this endpoint to sync and to run steps; requests are verified with the signing key.
  app.route({
    method: ['GET', 'POST', 'PUT'],
    url: '/api/inngest',
    handler: serve({ client: inngest, functions }),
  });

  return app;
}
