import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../build-app.js';
import { TEST_DATABASE_URL } from '../discussion/test-kit.js';
import { createFlowKit, draftJson, fid, type FlowKit } from './test-kit.js';

describe.skipIf(!TEST_DATABASE_URL)('flow routes (real Postgres)', () => {
  let k: FlowKit;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    k = await createFlowKit({
      anthropic: () => ({
        text: draftJson(),
        finish: 'complete',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    app = buildApp({ discussion: k.service, flows: k.flows, env: {} });
  });
  afterAll(async () => {
    await app.close();
    await k.pool.end();
  });

  it('walks a flow through the API', async () => {
    const body = { clientRequestId: fid(), template: 'podcast-episode', title: '第 12 集' };
    const created = await app.inject({ method: 'POST', url: '/api/flows', payload: body });
    expect(created.statusCode).toBe(201);
    const id = created.json().flow.id as string;
    expect(created.json().flow.title).toBe('第 12 集');
    const again = await app.inject({ method: 'POST', url: '/api/flows', payload: body });
    expect(again.statusCode).toBe(200);

    const noNotes = await app.inject({ method: 'POST', url: `/api/flows/${id}/generate` });
    expect(noNotes.statusCode).toBe(409);
    expect(noNotes.json().error.code).toBe('needs_notes');

    await app.inject({ method: 'PATCH', url: `/api/flows/${id}`, payload: { notes: '重點' } });
    const gen = await app.inject({ method: 'POST', url: `/api/flows/${id}/generate` });
    expect(gen.statusCode).toBe(200);
    expect(gen.json().flow.options).toHaveLength(3);

    const choose = await app.inject({
      method: 'POST',
      url: `/api/flows/${id}/choose`,
      payload: { title: '標題', description: '描述' },
    });
    expect(choose.json().flow.chosen.title).toBe('標題');
    const badTime = await app.inject({
      method: 'POST',
      url: `/api/flows/${id}/schedule`,
      payload: { publishAt: 'tomorrow' },
    });
    expect(badTime.statusCode).toBe(400);
    const tick = await app.inject({
      method: 'POST',
      url: `/api/flows/${id}/steps/trim/done`,
      payload: { done: true },
    });
    expect(tick.json().flow.steps.find((s: { key: string }) => s.key === 'trim').status).toBe(
      'done',
    );
    const list = await app.inject({ method: 'GET', url: '/api/flows' });
    expect(list.json().flows).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/api/flows/not-an-id' })).statusCode).toBe(404);
  });
});
