/** Starts a queued call somewhere that can run it. `attempt` makes the start request idempotent. */
export interface Dispatcher {
  dispatch(messageId: string, attempt: number): Promise<void>;
  /** Lets the service hand over how a call is run (used by the in-process dispatcher). */
  bind?(run: (messageId: string) => Promise<unknown>): void;
}

/** Runs the call in this process, without waiting for it. For local work and tests only. */
export class InlineDispatcher implements Dispatcher {
  private run: ((messageId: string) => Promise<unknown>) | undefined;
  private readonly pending = new Set<Promise<unknown>>();

  bind(run: (messageId: string) => Promise<unknown>) {
    this.run = run;
  }

  async dispatch(messageId: string): Promise<void> {
    if (!this.run) throw new Error('InlineDispatcher is not bound to a service');
    const p = this.run(messageId).catch(() => undefined);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Resolves when every call started so far has ended. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}
