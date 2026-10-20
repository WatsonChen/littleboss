import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageView } from '@littleboss/shared';
import { ProviderError, type ProviderRequest, type ProviderResult } from './providers/index.js';
import { createKit, resetDiscussionTables, TEST_DATABASE_URL, type Kit } from './test-kit.js';
import { splitVerdict } from './prompt.js';

const USAGE = { inputTokens: 100, outputTokens: 50 };
const ok = (text: string, usage = USAGE): ProviderResult => ({ text, finish: 'complete', usage });
let n = 0;
const rid = () => `auto-${Date.now()}-${n++}`;

/** A model that answers by role and numbers its turns, so a test can see who said what. */
function talker(who: string, verdict: (req: ProviderRequest, said: number) => 'continue' | 'done') {
  let said = 0;
  return (req: ProviderRequest): ProviderResult => {
    said += 1;
    if (req.system.includes('You are the reviewer')) return ok(`${who} 檢核：可行`);
    if (req.system.includes('is over. Write the summary')) return ok(`${who} 小結：共識與分歧`);
    return ok(`${who} 第${said}次發言\nNEXT: ${verdict(req, said)}`);
  };
}

describe('splitVerdict', () => {
  it('reads and strips the last-line verdict, in any case or with emphasis', () => {
    expect(splitVerdict('內容\nNEXT: done')).toEqual({ content: '內容', done: true });
    expect(splitVerdict('內容\n**NEXT: continue**')).toEqual({ content: '內容', done: false });
    expect(splitVerdict('內容 next: DONE.')).toEqual({ content: '內容', done: true });
  });
  it('treats a missing or garbled verdict as unknown, and keeps the text', () => {
    expect(splitVerdict('只有內容')).toEqual({ content: '只有內容', done: null });
    expect(splitVerdict('NEXT: maybe')).toEqual({ content: 'NEXT: maybe', done: null });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('automatic discussion (real Postgres)', () => {
  let kit: Kit;
  let threadId: string;
  const agents = (ms: MessageView[]) => ms.filter((m) => m.role === 'agent');
  const thread = async () => (await kit.service.getThread(threadId)).messages;

  async function setup(
    behaviour: Parameters<typeof createKit>[0],
    opts: {
      participants?: ('claude' | 'gpt')[];
      reviewer?: 'claude' | 'gpt' | null;
      maxRounds?: number;
      budget?: number;
    } = {},
    config: Parameters<typeof createKit>[1] = {},
  ) {
    if (kit) await kit.pool.end();
    kit = await createKit(behaviour, config);
    await resetDiscussionTables(kit.pool);
    threadId = (
      await kit.service.createThread({
        title: 't',
        budgetLimitMicro: opts.budget ?? 2_000_000,
        participants: opts.participants ?? ['claude', 'gpt'],
        reviewer: opts.reviewer === undefined ? null : opts.reviewer,
        maxRounds: opts.maxRounds ?? 2,
      })
    ).id;
  }
  const ask = (content = '我想做一個數位產品，有什麼方向？', extra = {}) =>
    kit.service.send(threadId, { clientRequestId: rid(), kind: 'user', content, ...extra });
  beforeEach(() =>
    setup({
      anthropic: talker('Claude', () => 'continue'),
      openai: talker('GPT', () => 'continue'),
    }),
  );
  afterAll(() => kit?.pool.end());

  it('AIs take turns on their own, then a summary: nobody has to press anything', async () => {
    const r = await ask();
    // The send itself only starts the first turn.
    expect(r.messages.map((m) => [m.role, m.agentId, m.autoKind])).toEqual([
      ['user', null, null],
      ['agent', 'claude', 'discussion'],
    ]);
    await kit.dispatcher.idle();
    const ms = agents(await thread());
    expect(ms.map((m) => [m.agentId, m.autoKind, m.status])).toEqual([
      ['claude', 'discussion', 'succeeded'],
      ['gpt', 'discussion', 'succeeded'],
      ['claude', 'discussion', 'succeeded'],
      ['gpt', 'discussion', 'succeeded'],
      ['claude', 'summary', 'succeeded'],
    ]);
    expect(ms[0]!.content).toBe('Claude 第1次發言'); // the verdict line is not part of the reply
    expect(ms[4]!.content).toBe('Claude 小結：共識與分歧');
  });

  it('stops early when every AI says it has nothing more to add, instead of padding the rounds', async () => {
    // Round 1 always continues; from the second round everyone says done.
    await setup(
      {
        anthropic: talker('Claude', (_r, said) => (said >= 2 ? 'done' : 'continue')),
        openai: talker('GPT', (_r, said) => (said >= 2 ? 'done' : 'continue')),
      },
      { maxRounds: 4 },
    );
    await ask();
    await kit.dispatcher.idle();
    const ms = agents(await thread());
    // 4 turns (2 rounds) + summary, not 8 + summary.
    expect(ms.map((m) => m.autoKind)).toEqual([
      'discussion',
      'discussion',
      'discussion',
      'discussion',
      'summary',
    ]);
  });

  it('each AI sees what the others said, and is told to add something new after the first round', async () => {
    await ask();
    await kit.dispatcher.idle();
    const gptSecond = kit.providers.openai.calls[0]!;
    expect(gptSecond.user).toContain('Claude 第1次發言');
    expect(gptSecond.system).toContain('You speak after others');
    const claudeSecond = kit.providers.anthropic.calls[1]!;
    expect(claudeSecond.user).toContain('GPT 第1次發言');
    expect(claudeSecond.system).toContain('Every reply must add something new');
    expect(claudeSecond.system).toContain(`exactly "NEXT: done"`);
  });

  it('a single participant just answers: no turns to pad, no summary', async () => {
    await setup(
      { anthropic: talker('Claude', () => 'done') },
      { participants: ['claude'], maxRounds: 3 },
    );
    await ask();
    await kit.dispatcher.idle();
    expect(agents(await thread()).map((m) => m.autoKind)).toEqual(['discussion']);
  });

  it('an @-mention is a plain call: no chain, as before', async () => {
    await ask('@gpt 你覺得呢？');
    await kit.dispatcher.idle();
    const ms = agents(await thread());
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ agentId: 'gpt', autoKind: null });
  });

  it('the same request id never starts a second discussion', async () => {
    const id = rid();
    const body = { clientRequestId: id, kind: 'user' as const, content: '問題' };
    await kit.service.send(threadId, body);
    const again = await kit.service.send(threadId, body);
    await kit.dispatcher.idle();
    expect(again.deduplicated).toBe(true);
    expect(agents(await thread())).toHaveLength(5);
  });

  it('the estimate covers the most the whole discussion could run, and a lower accepted cost is refused', async () => {
    const e = await kit.service.estimate(threadId, { content: '問題' });
    expect(e.calls).toHaveLength(5); // 2 AIs x 2 rounds + summary
    expect(e.auto).toEqual({ maxTurns: 5, includesSummary: true });
    await expect(ask('問題', { acceptedMaxCostMicro: 1 })).rejects.toMatchObject({
      code: 'estimate_changed',
    });
    const one = await kit.service.estimate(threadId, { content: '再來一輪', rounds: 1 });
    expect(one.calls).toHaveLength(3);
  });

  it('refuses to start a discussion that could not be afforded', async () => {
    await setup(
      { anthropic: talker('Claude', () => 'continue'), openai: talker('GPT', () => 'continue') },
      { budget: 1000 },
    );
    await expect(ask()).rejects.toMatchObject({ status: 402, code: 'over_budget' });
    expect(await thread()).toHaveLength(0);
  });

  it('a turn that cannot be afforded mid-way is shown as stopped, and can be retried when budget allows', async () => {
    // The first turn really costs far more than estimated, so the next one no longer fits.
    await setup({
      anthropic: () => ok('Claude 發言\nNEXT: continue', { inputTokens: 700_000, outputTokens: 0 }),
      openai: talker('GPT', () => 'continue'),
    });
    await ask();
    await kit.dispatcher.idle();
    const ms = agents(await thread());
    expect(ms.map((m) => [m.agentId, m.status])).toEqual([
      ['claude', 'succeeded'],
      ['gpt', 'failed'],
    ]);
    expect(ms[1]!.error?.code).toBe('over_budget');
    expect(ms[1]!.costMicro).toBe(0);
    await expect(kit.service.retry(ms[1]!.id)).rejects.toMatchObject({ code: 'over_budget' });
  });

  it('a failed turn stops the discussion; retrying it carries on to the end', async () => {
    let boom = true;
    await setup({
      anthropic: talker('Claude', () => 'continue'),
      openai: (req) => {
        if (boom) {
          boom = false;
          throw new ProviderError('network', 'down');
        }
        return talker('GPT', () => 'continue')(req);
      },
    });
    await ask();
    await kit.dispatcher.idle();
    let ms = agents(await thread());
    expect(ms.map((m) => m.status)).toEqual(['succeeded', 'failed']);

    await kit.service.retry(ms[1]!.id);
    await kit.dispatcher.idle();
    ms = agents(await thread());
    expect(ms.map((m) => m.status)).toEqual(Array(5).fill('succeeded'));
    expect(ms[4]!.autoKind).toBe('summary');
  });

  it('reconcile re-creates a missing next step exactly once, however often it runs', async () => {
    await setup(
      { anthropic: talker('Claude', () => 'continue'), openai: talker('GPT', () => 'continue') },
      {},
      { staleChainMs: 0 },
    );
    await ask();
    await kit.dispatcher.idle();
    await kit.pool.query(`delete from thread_messages where auto_kind = 'summary'`);
    const first = await kit.service.reconcile();
    const second = await kit.service.reconcile();
    await kit.dispatcher.idle();
    expect(first.continued).toBe(1);
    expect(second.continued).toBe(0);
    expect(agents(await thread()).filter((m) => m.autoKind === 'summary')).toHaveLength(1);
  });

  it('a call that was queued but never handed over is started by the sweep', async () => {
    await setup(
      { anthropic: talker('Claude', () => 'continue'), openai: talker('GPT', () => 'continue') },
      {},
      { staleQueuedMs: 0 },
    );
    await ask();
    // The hand-off "failed": undo the work and put the call back as never started.
    await kit.dispatcher.idle();
    await kit.pool.query(
      `delete from thread_messages where auto_turn > 0 or auto_kind = 'summary'`,
    );
    await kit.pool.query(
      `update thread_messages set status='queued', attempt_count=0, content='' where auto_turn = 0`,
    );
    expect((await kit.service.reconcile()).redispatched).toBe(1);
    await kit.dispatcher.idle();
    expect(agents(await thread()).length).toBeGreaterThan(1);
  });

  describe('the reviewer', () => {
    const conclude = async () => {
      const ms = await thread();
      const first = ms.find((m) => m.role === 'agent')!;
      return kit.service.saveConclusion(threadId, {
        title: '方向',
        content: '先做 A，用 B 當備案',
        sourceMessageIds: [first.id],
      });
    };

    it('checks a conclusion automatically as soon as the boss saves it', async () => {
      await setup(
        { anthropic: talker('Claude', () => 'continue'), openai: talker('GPT', () => 'continue') },
        { reviewer: 'gpt' },
      );
      await ask();
      await kit.dispatcher.idle();
      const before = (await thread()).length;
      await conclude();
      await kit.dispatcher.idle();
      const ms = (await thread()).slice(before);
      expect(ms.map((m) => [m.role, m.agentId, m.autoKind, m.status])).toEqual([
        ['user', null, 'review_request', 'sent'],
        ['agent', 'gpt', 'review', 'succeeded'],
      ]);
      expect(ms[1]!.content).toBe('GPT 檢核：可行');
      // The reviewer was shown the saved text as the thing to check.
      const sent = kit.providers.openai.calls.at(-1)!;
      expect(sent.user).toContain('<review_target');
      expect(sent.user).toContain('先做 A，用 B 當備案');
      expect(sent.system).toContain('You are the reviewer');
    });

    it('does nothing extra when no reviewer was chosen', async () => {
      await ask();
      await kit.dispatcher.idle();
      const before = (await thread()).length;
      await conclude();
      await kit.dispatcher.idle();
      expect(await thread()).toHaveLength(before);
    });

    it('a new version of the conclusion is checked again', async () => {
      await setup(
        { anthropic: talker('Claude', () => 'continue'), openai: talker('GPT', () => 'continue') },
        { reviewer: 'claude' },
      );
      await ask();
      await kit.dispatcher.idle();
      const v1 = await conclude();
      await kit.service.saveConclusion(threadId, {
        title: '方向',
        content: '改過的結論',
        sourceMessageIds: v1.sourceMessageIds,
        assetId: v1.assetId,
      });
      await kit.dispatcher.idle();
      const reviews = agents(await thread()).filter((m) => m.autoKind === 'review');
      expect(reviews).toHaveLength(2);
    });
  });
});
