import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageView } from '@littleboss/shared';
import { ProviderError, type ProviderResult } from './providers/index.js';
import { createKit, resetDiscussionTables, TEST_DATABASE_URL, type Kit } from './test-kit.js';

const ok = (text: string, usage = { inputTokens: 100, outputTokens: 50 }): ProviderResult => ({
  text,
  finish: 'complete',
  usage,
});
let n = 0;
const rid = () => `req-${Date.now()}-${n++}`;

describe.skipIf(!TEST_DATABASE_URL)('discussion service (real Postgres)', () => {
  let kit: Kit;
  let threadId: string;
  const agentMsgs = (ms: MessageView[]) => ms.filter((m) => m.role === 'agent');

  async function setup(
    behaviour: Parameters<typeof createKit>[0] = {},
    config: Parameters<typeof createKit>[1] = {},
  ) {
    if (kit) await kit.pool.end();
    kit = await createKit(behaviour, config);
    await resetDiscussionTables(kit.pool);
    threadId = (await kit.service.createThread({ title: 't', budgetLimitMicro: 1_000_000 })).id;
  }
  beforeAll(() => setup());
  beforeEach(() => setup());
  afterAll(() => kit.pool.end());

  it('a message to one AI becomes a saved call that finishes, with prompt and real usage', async () => {
    await setup({ anthropic: () => ok('方案 A') });
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 幫我想個提案',
    });
    expect(r.deduplicated).toBe(false);
    expect(r.messages.map((m) => [m.role, m.status])).toEqual([
      ['user', 'sent'],
      ['agent', 'queued'],
    ]);
    await kit.dispatcher.idle();

    const detail = await kit.service.getThread(threadId);
    const call = agentMsgs(detail.messages)[0]!;
    expect(call).toMatchObject({
      status: 'succeeded',
      content: '方案 A',
      agentId: 'claude',
      attemptCount: 1,
    });
    expect(call.costIsEstimate).toBe(false);
    expect(call.costMicro).toBe(100 * 3 + 50 * 15);
    expect(detail.thread.spentMicro).toBe(call.costMicro);

    const rec = await kit.service.record(call.id);
    expect(JSON.stringify(rec.prompt)).toContain('幫我想個提案');
    expect(rec.injectedMemory).toEqual([]);
  });

  it('claude proposes, gpt checks it, claude revises: each step sees the earlier ones', async () => {
    await setup({
      anthropic: (req) => ok(req.user.includes('<review_target') ? '修訂版' : '初稿'),
      openai: () => ok('第 3 點有問題'),
    });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 提案',
    });
    await kit.dispatcher.idle();
    let msgs = (await kit.service.getThread(threadId)).messages;
    const proposal = agentMsgs(msgs)[0]!;

    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@gpt 檢查上面的提案',
      replyToId: proposal.id,
    });
    await kit.dispatcher.idle();
    expect(kit.providers.openai.calls[0]!.user).toContain(`<review_target author="Claude">\n初稿`);

    msgs = (await kit.service.getThread(threadId)).messages;
    const review = agentMsgs(msgs)[1]!;
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 依照檢查意見修改',
      replyToId: review.id,
    });
    await kit.dispatcher.idle();
    const last = kit.providers.anthropic.calls[1]!.user;
    expect(last).toContain('第 3 點有問題');
    expect(last).toContain('[Claude]\n初稿');
  });

  it('parallel calls from one message see the same snapshot and not each other', async () => {
    await setup({ anthropic: () => ok('甲'), openai: () => ok('乙') });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'context',
      content: '客戶背景：預算 50 萬',
    });
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude @gpt 各自提案',
    });
    await kit.dispatcher.idle();
    const [a, b] = agentMsgs((await kit.service.getThread(threadId)).messages);
    expect(a!.seenMessageIds).toEqual(b!.seenMessageIds);
    expect(a!.seenMessageIds).toHaveLength(2); // the background note and the message itself
    expect(kit.providers.anthropic.calls[0]!.user).not.toContain('乙');
    expect(kit.providers.openai.calls[0]!.user).not.toContain('甲');
    expect(kit.providers.openai.calls[0]!.user).toContain('<background>\n客戶背景：預算 50 萬');
    expect(r.messages.filter((m) => m.role === 'agent')).toHaveLength(2);
  });

  it('pasted background never starts a call, even if it contains @mentions', async () => {
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'context',
      content: '他說 @claude 很強',
    });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0]).toMatchObject({ role: 'context', status: 'sent' });
    expect(kit.providers.anthropic.calls).toHaveLength(0);
  });

  it('one AI failing does not erase the other, and a retry keeps the earlier error', async () => {
    let gptCalls = 0;
    await setup({
      anthropic: () => ok('甲'),
      openai: () => {
        gptCalls += 1;
        if (gptCalls === 1) throw new ProviderError('http', 'HTTP 500: boom', 500);
        return ok('乙');
      },
    });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude @gpt 提案',
    });
    await kit.dispatcher.idle();
    let calls = agentMsgs((await kit.service.getThread(threadId)).messages);
    expect(calls.map((c) => [c.agentId, c.status])).toEqual([
      ['claude', 'succeeded'],
      ['gpt', 'failed'],
    ]);
    expect(calls[0]!.content).toBe('甲');
    expect(calls[1]!.error?.code).toBe('provider_error');

    const retried = await kit.service.retry(calls[1]!.id);
    expect(retried.status).toBe('queued');
    await kit.dispatcher.idle();
    calls = agentMsgs((await kit.service.getThread(threadId)).messages);
    expect(calls[1]).toMatchObject({ status: 'succeeded', content: '乙', attemptCount: 2 });
    const rec = await kit.service.record(calls[1]!.id);
    expect(rec.attempts).toHaveLength(1);
    expect(JSON.stringify(rec.attempts[0])).toContain('HTTP 500');
    expect(calls[0]!.content).toBe('甲');
  });

  it('error codes: rate limit, bad key, network, timeout', async () => {
    const results: ProviderError[] = [
      new ProviderError('http', 'HTTP 429', 429),
      new ProviderError('http', 'HTTP 401', 401),
      new ProviderError('network', 'down'),
      new ProviderError('timeout', 'slow'),
    ];
    const seen: string[] = [];
    for (const e of results) {
      await setup({ anthropic: () => Promise.reject(e) });
      await kit.service.send(threadId, {
        clientRequestId: rid(),
        kind: 'user',
        content: '@claude hi',
      });
      await kit.dispatcher.idle();
      const c = agentMsgs((await kit.service.getThread(threadId)).messages)[0]!;
      seen.push(`${c.status}:${c.error?.code}`);
      if (c.status === 'timed_out') expect(c.costMicro).toBe(c.estimatedCostMicro);
      else expect(c.costMicro).toBe(0);
    }
    expect(seen).toEqual([
      'failed:rate_limited',
      'failed:auth_failed',
      'failed:network_error',
      'timed_out:timeout',
    ]);
  });

  it('double click: the same request id never creates a second message or call', async () => {
    await setup({ anthropic: () => ok('甲') });
    const id = rid();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        kit.service.send(threadId, { clientRequestId: id, kind: 'user', content: '@claude 提案' }),
      ),
    );
    await kit.dispatcher.idle();
    expect(results.filter((r) => !r.deduplicated)).toHaveLength(1);
    const msgs = (await kit.service.getThread(threadId)).messages;
    expect(msgs).toHaveLength(2);
    expect(kit.providers.anthropic.calls).toHaveLength(1);
    // every duplicate answer points at the same messages
    expect(new Set(results.map((r) => r.messages.map((m) => m.id).join())).size).toBe(1);
  });

  it('two workers picking up the same call at once: the model is paid once', async () => {
    await setup({
      anthropic: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return ok('甲');
      },
    });
    kit.dispatcher.dispatch = async () => undefined; // nobody runs it automatically
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 提案',
    });
    const callId = r.messages[1]!.id;
    const both = await Promise.all([kit.service.runCall(callId), kit.service.runCall(callId)]);
    expect(both.filter((x) => x.ran)).toHaveLength(1);
    expect(kit.providers.anthropic.calls).toHaveLength(1);
    expect(agentMsgs((await kit.service.getThread(threadId)).messages)[0]).toMatchObject({
      status: 'succeeded',
      attemptCount: 1,
    });
  });

  it('a call whose worker vanished can be retried after the stale period; a late finish is ignored', async () => {
    await setup({ anthropic: () => ok('新答案') }, { staleRunningMs: 0 });
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 提案',
    });
    const callId = r.messages[1]!.id;
    await kit.dispatcher.idle();
    // Pretend the first worker died mid-call.
    await kit.pool.query(
      `update thread_messages set status='running', started_at=now() - interval '10 minutes', content='' where id=$1`,
      [callId],
    );
    const retried = await kit.service.retry(callId);
    expect(retried.status).toBe('queued');
    await kit.dispatcher.idle();
    const call = agentMsgs((await kit.service.getThread(threadId)).messages)[0]!;
    expect(call).toMatchObject({ status: 'succeeded', content: '新答案' });
  });

  it('retry is refused while a call is healthy and in progress', async () => {
    await setup({ anthropic: () => ok('x') });
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude hi',
    });
    await kit.dispatcher.idle();
    await expect(kit.service.retry(r.messages[1]!.id)).rejects.toMatchObject({
      status: 409,
      code: 'not_retryable',
    });
  });

  it('a lost hand-off leaves the call queued, and it can be retried once it is stale', async () => {
    await setup({ anthropic: () => ok('甲') }, { staleQueuedMs: 0 });
    const original = kit.dispatcher.dispatch.bind(kit.dispatcher);
    kit.dispatcher.dispatch = async () => {
      throw new Error('inngest down');
    };
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude hi',
    });
    expect(r.messages[1]!.status).toBe('queued');
    kit.dispatcher.dispatch = original;
    await kit.service.retry(r.messages[1]!.id);
    await kit.dispatcher.idle();
    expect(agentMsgs((await kit.service.getThread(threadId)).messages)[0]!.status).toBe(
      'succeeded',
    );
  });

  it('a cut-off reply is kept, can be read, fixed by hand, and then counts as a reply', async () => {
    await setup({
      anthropic: () => ({
        text: '前半段',
        finish: 'truncated',
        usage: { inputTokens: 10, outputTokens: 2048 },
      }),
      openai: () => ok('看到了'),
    });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 長文',
    });
    await kit.dispatcher.idle();
    const bad = agentMsgs((await kit.service.getThread(threadId)).messages)[0]!;
    expect(bad).toMatchObject({ status: 'bad_format', content: '前半段' });
    expect(bad.error?.code).toBe('truncated');

    // Not visible to other AIs until fixed.
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@gpt 看看討論',
    });
    await kit.dispatcher.idle();
    expect(kit.providers.openai.calls[0]!.user).not.toContain('前半段');

    const fixed = await kit.service.editBadFormat(bad.id, { content: '前半段 + 我補完的結尾' });
    expect(fixed).toMatchObject({ status: 'succeeded', editedByUser: true, error: null });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@gpt 再看一次',
    });
    await kit.dispatcher.idle();
    expect(kit.providers.openai.calls[1]!.user).toContain('我補完的結尾');
    expect(JSON.stringify((await kit.service.record(bad.id)).attempts)).toContain('前半段');
    await expect(kit.service.editBadFormat(bad.id, { content: 'again' })).rejects.toMatchObject({
      code: 'not_editable',
    });
  });

  it('refused and empty replies are bad_format, not success', async () => {
    for (const finish of ['refused', 'empty'] as const) {
      await setup({ anthropic: () => ({ text: '', finish, usage: null }) });
      await kit.service.send(threadId, {
        clientRequestId: rid(),
        kind: 'user',
        content: '@claude hi',
      });
      await kit.dispatcher.idle();
      const c = agentMsgs((await kit.service.getThread(threadId)).messages)[0]!;
      expect(c).toMatchObject({ status: 'bad_format', costIsEstimate: true });
      expect(c.error?.code).toBe(finish);
    }
  });

  it('closing and reopening: everything is still there, in order', async () => {
    await setup({ anthropic: () => ok('甲') });
    await kit.service.send(threadId, { clientRequestId: rid(), kind: 'context', content: '背景' });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 提案',
    });
    await kit.dispatcher.idle();
    const first = await kit.service.getThread(threadId);
    const reopened = await (await createKit()).service.getThread(threadId);
    expect(reopened.messages).toEqual(first.messages);
    expect(first.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
    expect((await kit.service.listThreads())[0]).toMatchObject({ id: threadId, messageCount: 3 });
  });

  it('mentioning an AI that is not hired is refused and nothing is written', async () => {
    await expect(
      kit.service.send(threadId, { clientRequestId: rid(), kind: 'user', content: '@gemini 你好' }),
    ).rejects.toMatchObject({ status: 400, code: 'agent_not_hired' });
    expect((await kit.service.getThread(threadId)).messages).toHaveLength(0);
    const roster = (await kit.service.getThread(threadId)).agents;
    expect(roster.find((a) => a.id === 'gemini')?.hired).toBe(false);
  });

  it('estimate matches what send records, and is marked as an estimate', async () => {
    await setup({ anthropic: () => ok('x'), openai: () => ok('y') });
    const est = await kit.service.estimate(threadId, { content: '@claude @gpt 提案' });
    expect(est.isEstimate).toBe(true);
    expect(est.calls).toHaveLength(2);
    expect(est.totalMicro).toBe(est.calls.reduce((s, c) => s + c.estimatedCostMicro, 0));
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude @gpt 提案',
      acceptedMaxCostMicro: est.totalMicro,
    });
    expect(agentMsgs(r.messages).map((m) => m.estimatedCostMicro)).toEqual(
      est.calls.map((c) => c.estimatedCostMicro),
    );
  });

  it('refuses to send when the cost grew past what the person confirmed', async () => {
    const est = await kit.service.estimate(threadId, { content: '@claude 提案' });
    await expect(
      kit.service.send(threadId, {
        clientRequestId: rid(),
        kind: 'user',
        content: '@claude 提案',
        acceptedMaxCostMicro: est.totalMicro - 1,
      }),
    ).rejects.toMatchObject({ status: 409, code: 'estimate_changed' });
    expect((await kit.service.getThread(threadId)).messages).toHaveLength(0);
  });

  it('budget counts the combined estimate of all calls in a send, and what is already spent', async () => {
    await setup({ anthropic: () => ok('x'), openai: () => ok('y') });
    const est = await kit.service.estimate(threadId, { content: '@claude @gpt a' });
    const one = est.calls[0]!.estimatedCostMicro;
    // Room for one call but not for both.
    const t2 = (await kit.service.createThread({ budgetLimitMicro: one + 1 })).id;
    await expect(
      kit.service.send(t2, { clientRequestId: rid(), kind: 'user', content: '@claude @gpt a' }),
    ).rejects.toMatchObject({ status: 402, code: 'over_budget' });
    expect((await kit.service.getThread(t2)).messages).toHaveLength(0);
    // One call fits; then the second does not, because the first is counted.
    await kit.service.send(t2, { clientRequestId: rid(), kind: 'user', content: '@claude a' });
    await kit.dispatcher.idle();
    await expect(
      kit.service.send(t2, { clientRequestId: rid(), kind: 'user', content: '@claude a' }),
    ).rejects.toMatchObject({ code: 'over_budget' });
    // Notes and pasted background are free.
    await kit.service.send(t2, { clientRequestId: rid(), kind: 'context', content: '背景' });
  });

  it('a retry that would exceed the budget is refused and leaves the failed call as it was', async () => {
    await setup({ anthropic: () => Promise.reject(new ProviderError('timeout', 'slow')) });
    const est = await kit.service.estimate(threadId, { content: '@claude a' });
    const t2 = (await kit.service.createThread({ budgetLimitMicro: est.totalMicro + 10 })).id;
    await kit.service.send(t2, { clientRequestId: rid(), kind: 'user', content: '@claude a' });
    await kit.dispatcher.idle();
    const call = agentMsgs((await kit.service.getThread(t2)).messages)[0]!;
    expect(call.status).toBe('timed_out'); // may have been billed, so it still counts
    await expect(kit.service.retry(call.id)).rejects.toMatchObject({ status: 402 });
    expect(agentMsgs((await kit.service.getThread(t2)).messages)[0]!.status).toBe('timed_out');
  });

  it('too much pasted text is refused before anything is sent', async () => {
    await setup({}, { maxInputTokens: 100 });
    await expect(
      kit.service.send(threadId, {
        clientRequestId: rid(),
        kind: 'user',
        content: '@claude ' + 'x'.repeat(1000),
      }),
    ).rejects.toMatchObject({ status: 413, code: 'context_too_large' });
  });

  it('a review target must be a visible message of the thread', async () => {
    await expect(
      kit.service.send(threadId, {
        clientRequestId: rid(),
        kind: 'user',
        content: '@gpt check',
        replyToId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toMatchObject({ code: 'bad_reply_target' });
  });

  it('conclusions: saved as a versioned asset; editing adds a version and never overwrites', async () => {
    await setup({ anthropic: () => ok('甲') });
    await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'user',
      content: '@claude 提案',
    });
    await kit.dispatcher.idle();
    const call = agentMsgs((await kit.service.getThread(threadId)).messages)[0]!;

    const v1 = await kit.service.saveConclusion(threadId, {
      title: '提案',
      content: '甲',
      sourceMessageIds: [call.id],
    });
    expect(v1.version).toBe(1);
    const v2 = await kit.service.saveConclusion(threadId, {
      title: '提案',
      content: '甲（我改過）',
      sourceMessageIds: [call.id],
      assetId: v1.assetId,
    });
    expect(v2).toMatchObject({ assetId: v1.assetId, version: 2 });
    const list = await kit.service.listConclusions(threadId);
    expect(list.map((c) => [c.version, c.content])).toEqual([
      [2, '甲（我改過）'],
      [1, '甲'],
    ]);

    const other = (await kit.service.createThread({})).id;
    await expect(
      kit.service.saveConclusion(other, { title: 'x', content: 'y', sourceMessageIds: [call.id] }),
    ).rejects.toMatchObject({ code: 'bad_source' });
    await expect(
      kit.service.saveConclusion(other, {
        title: 'x',
        content: 'y',
        sourceMessageIds: [call.id],
        assetId: v1.assetId,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('concurrent saves of one conclusion get distinct versions', async () => {
    await setup({ anthropic: () => ok('甲') });
    const r = await kit.service.send(threadId, {
      clientRequestId: rid(),
      kind: 'context',
      content: '背景',
    });
    const src = r.messages[0]!.id;
    const v1 = await kit.service.saveConclusion(threadId, {
      title: 'c',
      content: 'v1',
      sourceMessageIds: [src],
    });
    const vs = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        kit.service.saveConclusion(threadId, {
          title: 'c',
          content: `v${i}`,
          sourceMessageIds: [src],
          assetId: v1.assetId,
        }),
      ),
    );
    expect(new Set(vs.map((v) => v.version)).size).toBe(5);
  });

  it('concurrent sends to one thread get distinct, gap-free sequence numbers', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        kit.service.send(threadId, {
          clientRequestId: rid(),
          kind: 'context',
          content: `note ${i}`,
        }),
      ),
    );
    const seqs = (await kit.service.getThread(threadId)).messages.map((m) => m.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
