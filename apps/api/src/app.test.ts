import { describe, expect, it } from 'vitest';
import { HealthResponse } from '@littleboss/shared';
import { buildApp } from './app.js';

describe('GET /health', () => {
  it('returns a body that matches the shared contract', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(HealthResponse.safeParse(res.json()).success).toBe(true);
    await app.close();
  });
});
