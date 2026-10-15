import Fastify from 'fastify';
import { HealthResponse } from '@littleboss/shared';

export function buildApp() {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });

  app.get('/health', async () => {
    const body: HealthResponse = {
      ok: true,
      service: 'littleboss-api',
      time: new Date().toISOString(),
    };
    return HealthResponse.parse(body);
  });

  return app;
}
