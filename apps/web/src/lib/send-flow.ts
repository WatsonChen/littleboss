import type { EstimateResponse, SendMessageResponse } from '@littleboss/shared';
import { ApiRequestError, type ApiClient } from '../api';

export interface Draft {
  content: string;
  kind: 'user' | 'context';
  replyToId?: string;
  /** Overrides the discussion's round limit for this ask ("one more round"). */
  rounds?: number;
}

export type SendFlowState =
  | { step: 'idle' }
  | { step: 'estimating' }
  | { step: 'confirm'; draft: Draft; estimate: EstimateResponse; notice?: string }
  | { step: 'sending'; draft: Draft; estimate?: EstimateResponse }
  | { step: 'error'; draft: Draft; estimate?: EstimateResponse; code: string; message: string };

type Pending = { draft: Draft; clientRequestId: string; estimate?: EstimateResponse };

/**
 * One send, from "tap send" to "the server has it". It lives outside React so the rules are
 * testable:
 *  - a send that may cost money is shown with its estimate and needs a second tap;
 *  - the request id is made once per draft, so tapping twice, or retrying after a dropped
 *    connection, can never create a second message or a second paid call;
 *  - taps while a request is in flight are ignored.
 */
export class SendFlow {
  state: SendFlowState = { step: 'idle' };
  private pending: Pending | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private readonly client: ApiClient,
    private readonly threadId: string,
    private readonly onSent: (res: SendMessageResponse) => void,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = () => this.state;

  private set(state: SendFlowState) {
    this.state = state;
    this.listeners.forEach((l) => l());
  }

  /** Start sending a draft. Pasted background and plain notes go straight through; AI calls ask first. */
  async begin(draft: Draft): Promise<void> {
    if (this.state.step === 'estimating' || this.state.step === 'sending') return;
    this.pending = { draft, clientRequestId: this.newId() };
    if (draft.kind === 'context') return this.submit();
    this.set({ step: 'estimating' });
    try {
      const estimate = await this.client.estimate(this.threadId, {
        content: draft.content,
        replyToId: draft.replyToId,
        rounds: draft.rounds,
      });
      this.pending.estimate = estimate;
      if (estimate.calls.length === 0) return this.submit();
      this.set({ step: 'confirm', draft, estimate });
    } catch (err) {
      this.fail(draft, err);
    }
  }

  /** The person accepted the estimate (or tapped retry after an error). */
  async confirm(): Promise<void> {
    if (this.state.step !== 'confirm' && this.state.step !== 'error') return;
    if (!this.pending) return;
    return this.submit();
  }

  /** True when the same request can safely be sent again (e.g. after a dropped connection). */
  get canRetry(): boolean {
    return this.pending !== undefined;
  }

  cancel(): void {
    if (this.state.step === 'sending' || this.state.step === 'estimating') return;
    this.pending = undefined;
    this.set({ step: 'idle' });
  }

  private async submit(): Promise<void> {
    const p = this.pending!;
    this.set({ step: 'sending', draft: p.draft, estimate: p.estimate });
    try {
      const res = await this.client.sendMessage(this.threadId, {
        clientRequestId: p.clientRequestId,
        kind: p.draft.kind,
        content: p.draft.content,
        replyToId: p.draft.replyToId,
        rounds: p.draft.rounds,
        acceptedMaxCostMicro: p.estimate?.totalMicro,
      });
      this.pending = undefined;
      this.set({ step: 'idle' });
      this.onSent(res);
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === 'estimate_changed') {
        // Nothing was created; show the new estimate and ask again.
        try {
          const estimate = await this.client.estimate(this.threadId, {
            content: p.draft.content,
            replyToId: p.draft.replyToId,
            rounds: p.draft.rounds,
          });
          p.estimate = estimate;
          this.set({
            step: 'confirm',
            draft: p.draft,
            estimate,
            notice: '費用估算變高了，請重新確認',
          });
          return;
        } catch (e2) {
          return this.fail(p.draft, e2, p.estimate);
        }
      }
      this.fail(p.draft, err, p.estimate);
    }
  }

  private fail(draft: Draft, err: unknown, estimate?: EstimateResponse) {
    const e =
      err instanceof ApiRequestError
        ? err
        : new ApiRequestError(0, 'unknown', err instanceof Error ? err.message : String(err));
    // Errors that mean "this cannot work as written" drop the pending request; others can be retried.
    const retryable = e.code === 'network' || e.status >= 500;
    if (!retryable) this.pending = undefined;
    this.set({ step: 'error', draft, estimate, code: e.code, message: friendlyError(e) });
  }
}

export function friendlyError(e: ApiRequestError): string {
  switch (e.code) {
    case 'over_budget':
      return '這會超過這個討論的預算上限。';
    case 'agent_not_hired':
      return '你點名的 AI 還沒設定好（尚未聘用）。';
    case 'context_too_large':
      return '貼上的內容加上討論太長了，請縮短或另開討論。';
    case 'unauthorized':
      return '存取密碼不正確。';
    default:
      return e.message;
  }
}
