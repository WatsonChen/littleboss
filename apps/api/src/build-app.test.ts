import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@littleboss/shared';
import { buildApp } from './build-app.js';

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
});
