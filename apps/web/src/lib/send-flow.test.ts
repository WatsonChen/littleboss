import { describe, expect, it, vi } from 'vitest';
import type { EstimateResponse, SendMessageResponse } from '@littleboss/shared';
import { ApiRequestError, type ApiClient } from '../api';
import { SendFlow } from './send-flow';

const est = (total: number, calls = 1): EstimateResponse => ({
  calls: Array.from({ length: calls }, () => ({
    agentId: 'claude' as const,
    inputTokens: 10,
    maxOutputTokens: 100,
    estimatedCostMicro: total,
  })),
  totalMicro: total * calls,
  spentMicro: 0,
  budgetLimitMicro: 1_000_000,
  withinBudget: true,
  isEstimate: true,
});
const sent: SendMessageResponse = { deduplicated: false, messages: [] };

function fake(over: Partial<Record<'estimate' | 'sendMessage', unknown>>) {
  return {
    estimate: vi.fn(async () => est(5000)),
    sendMessage: vi.fn(async () => sent),
    ...over,
  } as unknown as ApiClient & {
    estimate: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
}
const draft = { content: '@claude 提案', kind: 'user' as const };

describe('SendFlow', () => {
  it('asks to confirm the estimate before anything is sent', async () => {
    const c = fake({});
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    expect(flow.state.step).toBe('confirm');
    expect(c.sendMessage).not.toHaveBeenCalled();
    await flow.confirm();
    expect(c.sendMessage).toHaveBeenCalledWith(
      't',
      expect.objectContaining({
        clientRequestId: 'id-1',
        acceptedMaxCostMicro: 5000,
        content: '@claude 提案',
      }),
    );
    expect(flow.state.step).toBe('idle');
  });

  it('tapping confirm many times sends once', async () => {
    let release!: () => void;
    const c = fake({ sendMessage: vi.fn(() => new Promise((r) => (release = () => r(sent)))) });
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    const taps = [flow.confirm(), flow.confirm(), flow.confirm()];
    release();
    await Promise.all(taps);
    expect(c.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('a dropped connection can be retried with the same request id', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError(0, 'network', '連不上'))
      .mockResolvedValueOnce(sent);
    const c = fake({ sendMessage: send });
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    await flow.confirm();
    expect(flow.state).toMatchObject({ step: 'error', code: 'network' });
    await flow.confirm();
    expect(send.mock.calls[0]![1].clientRequestId).toBe('id-1');
    expect(send.mock.calls[1]![1].clientRequestId).toBe('id-1');
    expect(flow.state.step).toBe('idle');
  });

  it('a notes-only message with no @mention is sent without a confirmation', async () => {
    const c = fake({ estimate: vi.fn(async () => est(0, 0)) });
    const onSent = vi.fn();
    const flow = new SendFlow(c, 't', onSent, () => 'id-1');
    await flow.begin({ content: '我自己記一下', kind: 'user' });
    expect(c.sendMessage).toHaveBeenCalledTimes(1);
    expect(onSent).toHaveBeenCalled();
  });

  it('pasted background skips the estimate entirely', async () => {
    const c = fake({});
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin({ content: '背景', kind: 'context' });
    expect(c.estimate).not.toHaveBeenCalled();
    expect(c.sendMessage).toHaveBeenCalledWith('t', expect.objectContaining({ kind: 'context' }));
  });

  it('when the cost grew, it asks again with the new estimate instead of sending', async () => {
    const estimate = vi.fn().mockResolvedValueOnce(est(5000)).mockResolvedValueOnce(est(9000));
    const send = vi.fn().mockRejectedValueOnce(new ApiRequestError(409, 'estimate_changed', 'x'));
    const c = fake({ estimate, sendMessage: send });
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    await flow.confirm();
    expect(flow.state).toMatchObject({ step: 'confirm', estimate: { totalMicro: 9000 } });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('over budget is shown plainly and not retried', async () => {
    const send = vi.fn().mockRejectedValue(new ApiRequestError(402, 'over_budget', 'x'));
    const flow = new SendFlow(
      fake({ sendMessage: send }),
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    await flow.confirm();
    expect(flow.state).toMatchObject({ step: 'error', code: 'over_budget' });
    await flow.confirm(); // nothing pending any more
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('cancel returns to idle without sending', async () => {
    const c = fake({});
    const flow = new SendFlow(
      c,
      't',
      () => {},
      () => 'id-1',
    );
    await flow.begin(draft);
    flow.cancel();
    expect(flow.state.step).toBe('idle');
    expect(c.sendMessage).not.toHaveBeenCalled();
  });
});
