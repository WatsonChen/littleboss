import { describe, expect, it, vi } from 'vitest';
import { HealthResponse } from '@littleboss/shared';
import { buildApp } from './build-app.js';

// Without keys the Inngest SDK refuses to serve in cloud mode (by design), so tests use dev mode.
vi.hoisted(() => {
  process.env.INNGEST_DEV = '1';
});

describe('GET /health', () => {
  it('returns a body that matches the shared contract', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.safeParse(res.json()).success).toBe(true);
    await app.close();
  });

  it('allows the configured web origin and rejects others', async () => {
    const app = buildApp();
    const ok = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example' },
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    await app.close();
  });

  it('serves the Inngest endpoint and lists the ping and ai-call functions', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/inngest' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ function_count: 2 });
    await app.close();
  });
});

describe('GET /health/db', () => {
  it('reports 503 with a code, not a crash, while no database is configured', async () => {
    const app = buildApp({ env: {} });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ ok: false, error: 'database_not_configured' });
    await app.close();
  });

  it('reports a connection failure by code only, never the connection string', async () => {
    const app = buildApp({ env: { DATABASE_URL: 'postgres://u:topsecret@127.0.0.1:1/db' } });
    const res = await app.inject({ method: 'GET', url: '/health/db' });
    expect(res.statusCode).toBe(503);
    expect(JSON.stringify(res.json())).not.toContain('topsecret');
    await app.close();
  });
});
