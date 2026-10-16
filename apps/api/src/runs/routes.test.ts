import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../build-app.js';
import { TEST_DATABASE_URL } from '../discussion/test-kit.js';
import { createRunKit, rid, type RunKit } from './test-kit.js';

describe.skipIf(!TEST_DATABASE_URL)('run routes (real Postgres)', () => {
  let k: RunKit;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    k = await createRunKit();
    app = buildApp({ discussion: k.service, runs: k.runs, env: {} });
  });
  afterAll(async () => {
    await app.close();
    await k.pool.end();
  });

  it('walks a run through the API: create, input, approval, result', async () => {
    const body = {
      clientRequestId: rid(),
      assetId: k.conclusion.assetId,
      agentId: 'claude',
      instruction: '排成清單',
    };
    const created = await app.inject({
      method: 'POST',
      url: `/api/threads/${k.threadId}/runs`,
      payload: body,
    });
    expect(created.statusCode).toBe(201);
    const runId = created.json().run.id as string;
    const again = await app.inject({
      method: 'POST',
      url: `/api/threads/${k.threadId}/runs`,
      payload: body,
    });
    expect(again.statusCode).toBe(200);
    expect(again.json().deduplicated).toBe(true);

    await k.engine.idle();
    const waiting = await app.inject({ method: 'GET', url: '/api/runs/waiting' });
    expect(waiting.json().runs.map((r: { id: string }) => r.id)).toContain(runId);

    const input = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/input`,
      payload: { stepName: 'human-return', text: '加上午餐' },
    });
    expect(input.json().accepted).toBe(true);
    await k.engine.idle();

    const run = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json().run;
    expect(run.state).toBe('waiting_approval');
    const approve = await app.inject({
      method: 'POST',
      url: `/api/runs/${runId}/approval`,
      payload: {
        stepName: 'approve-deliverable',
        proposalHash: run.pending.proposal.hash,
        decision: 'approved',
      },
    });
    expect(approve.json().accepted).toBe(true);
    await k.engine.idle();

    const done = (await app.inject({ method: 'GET', url: `/api/runs/${runId}` })).json().run;
    expect(done.state).toBe('succeeded');
    const list = await app.inject({ method: 'GET', url: `/api/threads/${k.threadId}/runs` });
    expect(list.json().runs).toHaveLength(1);
    const assets = await app.inject({
      method: 'GET',
      url: `/api/threads/${k.threadId}/conclusions`,
    });
    expect(assets.json().conclusions.some((a: { kind: string }) => a.kind === 'deliverable')).toBe(
      true,
    );
  });

  it('rejects malformed requests and unknown runs with stable codes', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: `/api/threads/${k.threadId}/runs`,
      payload: { agentId: 'claude' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_request');
    expect((await app.inject({ method: 'GET', url: '/api/runs/not-a-uuid' })).statusCode).toBe(404);
    const missing = await app.inject({
      method: 'GET',
      url: '/api/runs/00000000-0000-4000-8000-000000000000',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('run_not_found');
  });

  it('is behind the same access lock as the rest of the API', async () => {
    const locked = buildApp({
      discussion: k.service,
      runs: k.runs,
      env: { ACCESS_TOKEN: 'abc', NODE_ENV: 'production' },
    });
    expect((await locked.inject({ method: 'GET', url: '/api/runs/waiting' })).statusCode).toBe(401);
    expect(
      (
        await locked.inject({
          method: 'GET',
          url: '/api/runs/waiting',
          headers: { authorization: 'Bearer abc' },
        })
      ).statusCode,
    ).toBe(200);
    await locked.close();
  });
});
