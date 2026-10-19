import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureItemView, CaptureView } from '@littleboss/shared';
import { ProviderError } from '../discussion/providers/index.js';
import { TEST_DATABASE_URL } from '../discussion/test-kit.js';
import type { CalendarClient } from './calendar.js';
import { cid, createCaptureKit, event, modelJson, shopping, type CaptureKit } from './test-kit.js';

const USAGE = { inputTokens: 100, outputTokens: 50 };
const ok = (text: string) => ({ text, finish: 'complete' as const, usage: USAGE });
const COST_PER_CALL = 100 * 3 + 50 * 15;

const TOMORROW_3PM = '2026-10-20T15:00:00+08:00';
const MIXED = modelJson(
  [
    shopping('牛奶'),
    shopping('衛生紙', { origin: 'suggested' }),
    event('跟小美吃飯', TOMORROW_3PM),
    event('看牙醫', null),
  ],
  [],
);

describe.skipIf(!TEST_DATABASE_URL)('captures (real Postgres)', () => {
  let k: CaptureKit;

  async function setup(...args: Parameters<typeof createCaptureKit>) {
    if (k) await k.pool.end();
    k = await createCaptureKit(...args);
  }
  const create = (text = '買牛奶，明天下午三點跟小美吃飯', clientRequestId = cid()) =>
    k.captures.create({ clientRequestId, text });
  const ready = async (text?: string) => {
    const r = await create(text);
    await k.engine.idle();
    return k.captures.get(r.capture.id);
  };
  const item = (c: CaptureView, title: string): CaptureItemView =>
    c.items.find((i) => i.title === title)!;
  const approve = (c: CaptureView, title: string) => {
    const i = item(c, title);
    return k.captures.approveItem(c.id, i.id, { payloadHash: i.payloadHash });
  };
  const calls = () => k.providers.anthropic.calls.length;

  beforeEach(() => setup({ anthropic: () => ok(MIXED) }));
  afterAll(() => k.pool.end());

  it('turns a note into proposals; a missing time becomes a question, not a guess', async () => {
    const c = await ready();
    expect(c.state).toBe('ready');
    expect(c.items.map((i) => i.title)).toEqual(['牛奶', '衛生紙', '跟小美吃飯', '看牙醫']);
    expect(item(c, '衛生紙').origin).toBe('suggested');
    expect(item(c, '跟小美吃飯')).toMatchObject({ status: 'proposed', startsAt: TOMORROW_3PM });
    expect(item(c, '看牙醫')).toMatchObject({
      status: 'needs_info',
      startsAt: null,
      question: '什麼時候？',
    });
    expect(c.costMicro).toBe(COST_PER_CALL);
    // Nothing is written until the person approves.
    expect(await k.captures.listShopping()).toEqual([]);
  });

  it('a repeated create with the same request id starts nothing new', async () => {
    const id = cid();
    const a = await create('買牛奶', id);
    const b = await create('買牛奶', id);
    await k.engine.idle();
    expect(b.deduplicated).toBe(true);
    expect(b.capture.id).toBe(a.capture.id);
    expect(calls()).toBe(1);
  });

  it('refuses a note that would push the last 24 hours over the budget', async () => {
    await setup({ anthropic: () => ok(MIXED) }, { config: { dailyBudgetMicro: 1 } });
    await expect(create()).rejects.toMatchObject({ status: 402, code: 'over_budget' });
    expect(calls()).toBe(0);
  });

  it('rejects a note too long to send', async () => {
    await setup({ anthropic: () => ok(MIXED) }, { config: { maxInputTokens: 50 } });
    await expect(create('買'.repeat(2000))).rejects.toMatchObject({ status: 413 });
  });

  it('reply that is not JSON fails with the raw reply kept, and retry is bounded', async () => {
    await setup({ anthropic: () => ok('我不知道') }, { config: { maxAttempts: 2 } });
    const r = await create();
    await k.engine.idle();
    let c = await k.captures.get(r.capture.id);
    expect(c.state).toBe('failed');
    expect(c.error?.code).toBe('bad_format');
    c = await k.captures.retry(c.id);
    await k.engine.idle();
    c = await k.captures.get(c.id);
    expect(c.state).toBe('failed');
    expect(c.attemptCount).toBe(2);
    await expect(k.captures.retry(c.id)).rejects.toMatchObject({ code: 'too_many_attempts' });
  });

  it('retry after a failure can succeed', async () => {
    let first = true;
    await setup({
      anthropic: () => {
        if (first) {
          first = false;
          return ok('壞掉');
        }
        return ok(MIXED);
      },
    });
    const r = await create();
    await k.engine.idle();
    await k.captures.retry(r.capture.id);
    await k.engine.idle();
    expect((await k.captures.get(r.capture.id)).state).toBe('ready');
  });

  it('trouble that passes is retried once in process; lasting trouble fails cleanly', async () => {
    let n = 0;
    await setup({
      anthropic: () => {
        n += 1;
        if (n === 1) throw new ProviderError('timeout', 'slow');
        return ok(MIXED);
      },
    });
    expect((await ready()).state).toBe('ready');

    await setup({
      anthropic: () => {
        throw new ProviderError('network', 'down');
      },
    });
    const c = await ready();
    expect(c.state).toBe('failed');
    expect(c.error?.code).toBe('provider_unavailable');
  });

  it('a needs-info event cannot be approved until the person adds a time', async () => {
    const c = await ready();
    const dentist = item(c, '看牙醫');
    await expect(
      k.captures.approveItem(c.id, dentist.id, { payloadHash: dentist.payloadHash }),
    ).rejects.toMatchObject({ code: 'needs_info' });
    await expect(
      k.captures.editItem(c.id, dentist.id, { startsAt: '下週三' }),
    ).rejects.toMatchObject({ code: 'invalid_time' });
    const edited = await k.captures.editItem(c.id, dentist.id, {
      startsAt: '2026-10-21T10:00:00+08:00',
    });
    expect(item(edited, '看牙醫')).toMatchObject({ status: 'proposed', question: '' });
    const res = await approve(edited, '看牙醫');
    expect(res.accepted).toBe(true);
    expect(item(res.capture, '看牙醫').status).toBe('saved');
  });

  it('approving a stale version is refused: the person approves what they saw', async () => {
    const c = await ready();
    const meal = item(c, '跟小美吃飯');
    await k.captures.editItem(c.id, meal.id, { startsAt: '2026-10-20T18:00:00+08:00' });
    await expect(
      k.captures.approveItem(c.id, meal.id, { payloadHash: meal.payloadHash }),
    ).rejects.toMatchObject({ status: 409, code: 'stale_item' });
    expect(item(await k.captures.get(c.id), '跟小美吃飯').status).toBe('proposed');
  });

  it('shopping approval saves once even when approved twice', async () => {
    const c = await ready();
    const first = await approve(c, '牛奶');
    const second = await approve(first.capture, '牛奶');
    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(false);
    const list = await k.captures.listShopping();
    expect(list.map((s) => s.title)).toEqual(['牛奶']);
    const done = await k.captures.setShoppingDone(list[0]!.id, true);
    expect(done.done).toBe(true);
  });

  it('rejecting an item leaves the others alone and it can no longer be approved', async () => {
    const c = await ready();
    const tp = item(c, '衛生紙');
    const r = await k.captures.rejectItem(c.id, tp.id);
    expect(item(r.capture, '衛生紙').status).toBe('rejected');
    expect(item(r.capture, '牛奶').status).toBe('proposed');
    const again = await approve(r.capture, '衛生紙');
    expect(again.accepted).toBe(false);
    expect(await k.captures.listShopping()).toEqual([]);
  });

  it('in demo mode an event goes to the demo calendar and says so', async () => {
    const c = await ready();
    const res = await approve(c, '跟小美吃飯');
    expect(item(res.capture, '跟小美吃飯')).toMatchObject({
      status: 'saved',
      result: { destination: 'demo-calendar', demo: true },
    });
    const { rows } = await k.pool.query('select count(*)::int as n from demo_calendar_events');
    expect(rows[0].n).toBe(1);
  });

  it('with no calendar connected the event stays unsent and can be retried later', async () => {
    await setup(
      { anthropic: () => ok(MIXED) },
      { calendar: () => ({ kind: 'none', insert: async () => ({ status: 'not_connected' }) }) },
    );
    const c = await ready();
    const res = await approve(c, '跟小美吃飯');
    expect(item(res.capture, '跟小美吃飯')).toMatchObject({
      status: 'failed',
      error: { code: 'not_connected' },
    });
  });

  it('one failed write never blocks the others', async () => {
    const calendar: CalendarClient = {
      kind: 'google',
      insert: async () => ({ status: 'failed', code: 'http_500', reason: 'boom', retryable: true }),
    };
    await setup({ anthropic: () => ok(MIXED) }, { calendar: () => calendar });
    const c = await ready();
    const bad = await approve(c, '跟小美吃飯');
    expect(item(bad.capture, '跟小美吃飯').status).toBe('failed');
    const good = await approve(bad.capture, '牛奶');
    expect(item(good.capture, '牛奶').status).toBe('saved');
    expect(item(good.capture, '跟小美吃飯').status).toBe('failed');
  });

  it('an unknown outcome is reported honestly and a retry reuses the same event id', async () => {
    const ids: string[] = [];
    let n = 0;
    const calendar: CalendarClient = {
      kind: 'google',
      insert: async (e) => {
        ids.push(e.eventId);
        n += 1;
        if (n === 1) throw new Error('socket hang up');
        return { status: 'exists', destination: 'google-calendar', demo: false, link: null };
      },
    };
    await setup({ anthropic: () => ok(MIXED) }, { calendar: () => calendar });
    const c = await ready();
    const first = await approve(c, '跟小美吃飯');
    expect(item(first.capture, '跟小美吃飯')).toMatchObject({
      status: 'failed',
      error: { code: 'unknown_outcome' },
    });
    const second = await approve(first.capture, '跟小美吃飯');
    expect(item(second.capture, '跟小美吃飯').status).toBe('saved');
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('two taps at once write an event once', async () => {
    const c = await ready();
    const meal = item(c, '跟小美吃飯');
    const results = await Promise.all([
      k.captures.approveItem(c.id, meal.id, { payloadHash: meal.payloadHash }),
      k.captures.approveItem(c.id, meal.id, { payloadHash: meal.payloadHash }),
    ]);
    expect(results.filter((r) => r.accepted)).toHaveLength(1);
    const { rows } = await k.pool.query('select count(*)::int as n from demo_calendar_events');
    expect(rows[0].n).toBe(1);
  });

  it('a capture that was never started is picked up by the sweep, and only runs once', async () => {
    // Simulates a lost wake-up: the row exists but the engine never ran it.
    await setup({ anthropic: () => ok(MIXED) });
    const lost = k.restart();
    const { rows } = await k.pool.query(
      `insert into captures (text, state, client_request_id, config, estimated_cost_micro)
       values ('買牛奶','queued',$1,$2,0) returning id`,
      [
        cid(),
        JSON.stringify({
          roleVersion: '1',
          agentId: 'claude',
          agentName: 'Claude',
          model: 'm',
          timeZone: 'Asia/Taipei',
        }),
      ],
    );
    await k.pool.query(
      `update captures set created_at = now() - interval '1 hour', updated_at = now() - interval '1 hour'`,
    );
    expect(await lost.captures.reconcile()).toBe(1);
    await lost.engine.idle();
    expect((await lost.captures.get(rows[0].id)).state).toBe('ready');
    expect(calls()).toBe(1);
  });
});
