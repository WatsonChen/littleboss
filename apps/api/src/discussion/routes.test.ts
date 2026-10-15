import { describe, expect, it } from 'vitest';
import { buildApp } from '../build-app.js';
import { HttpError } from './errors.js';
import type { DiscussionService } from './service.js';

// Route-level behaviour with a stub service: validation, errors and the access lock.
const stub = {
  agents: () => [],
  listThreads: async () => [],
  createThread: async () => ({ id: 'x' }),
  send: async () => {
    throw new HttpError(402, 'over_budget', 'too much', { totalMicro: 5 });
  },
} as unknown as DiscussionService;

const app = (env: Record<string, string | undefined>) => buildApp({ discussion: stub, env });
const TOKEN = 'correct-horse';

describe('discussion routes', () => {
  it('without a configured token, production refuses everything instead of running open', async () => {
    const a = app({ NODE_ENV: 'production' });
    const res = await a.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('auth_not_configured');
    // health and the Inngest endpoint stay reachable
    expect((await a.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
  });

  it('with a token: wrong or missing is 401, right is accepted', async () => {
    const a = app({ ACCESS_TOKEN: TOKEN, NODE_ENV: 'production' });
    expect((await a.inject({ method: 'GET', url: '/api/threads' })).statusCode).toBe(401);
    expect(
      (
        await a.inject({
          method: 'GET',
          url: '/api/threads',
          headers: { authorization: 'Bearer nope' },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await a.inject({
      method: 'GET',
      url: '/api/threads',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(ok.statusCode).toBe(200);
  });

  it('invalid input is a 400 with a code, and a bad id is a 404', async () => {
    const a = app({});
    const bad = await a.inject({
      method: 'POST',
      url: '/api/threads/00000000-0000-4000-8000-000000000000/messages',
      payload: { clientRequestId: 'short', content: '' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
    expect((await a.inject({ method: 'GET', url: '/api/threads/not-a-uuid' })).statusCode).toBe(
      404,
    );
  });

  it('service errors keep their status, code and details', async () => {
    const res = await app({}).inject({
      method: 'POST',
      url: '/api/threads/00000000-0000-4000-8000-000000000000/messages',
      payload: { clientRequestId: 'abcdefgh-1', content: '@claude hi' },
    });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toMatchObject({ code: 'over_budget', totalMicro: 5 });
  });

  it('without a database the API says so instead of crashing', async () => {
    const a = buildApp({ env: {} });
    const res = await a.inject({ method: 'GET', url: '/api/threads' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('database_not_configured');
  });

  it('never leaks API keys through the agents list', async () => {
    const { Roster } = await import('./roster.js');
    const list = JSON.stringify(new Roster({ ANTHROPIC_API_KEY: 'sk-secret' }).list());
    expect(list).not.toContain('sk-secret');
  });
});
