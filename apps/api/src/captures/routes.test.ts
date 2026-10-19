import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../build-app.js';
import { TEST_DATABASE_URL } from '../discussion/test-kit.js';
import { cid, createCaptureKit, event, modelJson, shopping, type CaptureKit } from './test-kit.js';

describe.skipIf(!TEST_DATABASE_URL)('capture routes (real Postgres)', () => {
  let k: CaptureKit;
  let app: ReturnType<typeof buildApp>;
  beforeAll(async () => {
    k = await createCaptureKit({
      anthropic: () => ({
        text: modelJson([shopping('牛奶'), event('吃飯', '2026-10-20T15:00:00+08:00')]),
        finish: 'complete',
        usage: { inputTokens: 100, outputTokens: 50 },
      }),
    });
    app = buildApp({ discussion: k.service, captures: k.captures, env: {} });
  });
  afterAll(async () => {
    await app.close();
    await k.pool.end();
  });

  it('walks a capture through the API: create, review, approve each item, shopping list', async () => {
    const body = { clientRequestId: cid(), text: '買牛奶，明天下午三點吃飯' };
    const created = await app.inject({ method: 'POST', url: '/api/captures', payload: body });
    expect(created.statusCode).toBe(201);
    const id = created.json().capture.id as string;
    const again = await app.inject({ method: 'POST', url: '/api/captures', payload: body });
    expect(again.statusCode).toBe(200);
    expect(again.json().deduplicated).toBe(true);

    await k.engine.idle();
    const got = (await app.inject({ method: 'GET', url: `/api/captures/${id}` })).json().capture;
    expect(got.state).toBe('ready');
    const milk = got.items.find((i: { title: string }) => i.title === '牛奶');

    const bad = await app.inject({
      method: 'POST',
      url: `/api/captures/${id}/items/${milk.id}/approve`,
      payload: { payloadHash: 'nope' },
    });
    expect(bad.statusCode).toBe(409);
    const good = await app.inject({
      method: 'POST',
      url: `/api/captures/${id}/items/${milk.id}/approve`,
      payload: { payloadHash: milk.payloadHash },
    });
    expect(good.json().accepted).toBe(true);

    const list = (await app.inject({ method: 'GET', url: '/api/shopping' })).json().items;
    expect(list.map((s: { title: string }) => s.title)).toEqual(['牛奶']);
    const done = await app.inject({
      method: 'PATCH',
      url: `/api/shopping/${list[0].id}`,
      payload: { done: true },
    });
    expect(done.json().item.done).toBe(true);

    expect((await app.inject({ method: 'GET', url: '/api/captures/not-a-uuid' })).statusCode).toBe(
      404,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/captures', payload: { text: '' } }))
        .statusCode,
    ).toBe(400);
  });
});
