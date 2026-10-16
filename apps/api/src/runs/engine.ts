import { inngest } from '../inngest/client.js';
import type { RunEngine, RunService } from './service.js';

export const EVENT_RUN_DRIVE = 'littleboss/run.drive';

/** Drives runs in this process, without waiting for them. For local work and tests only. */
export class InlineRunEngine implements RunEngine {
  private drive: ((runId: string) => Promise<unknown>) | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  /** Keys already used, so a repeated kick is a no-op like an Inngest event id. */
  private readonly seen = new Set<string>();

  bind(drive: (runId: string) => Promise<unknown>) {
    this.drive = drive;
  }

  async kick(runId: string, key: string): Promise<void> {
    if (!this.drive) throw new Error('InlineRunEngine is not bound to a service');
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const p = this.drive(runId).catch(() => undefined);
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Resolves when everything started so far has stopped (finished or waiting for the person). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }
}

/** Hands the run to Inngest. The event id makes a repeated kick of the same moment a no-op. */
export class InngestRunEngine implements RunEngine {
  async kick(runId: string, key: string): Promise<void> {
    await inngest.send({ id: key, name: EVENT_RUN_DRIVE, data: { runId } });
  }
}

/**
 * One function drives a run until it finishes or waits for the person. A second function sweeps
 * every five minutes for runs whose wake-up got lost. Inngest retries the drive on unexpected
 * errors; steps already finished are kept in our database, so a retry never repeats them.
 */
export function createRunFunctions(getService: () => RunService) {
  const drive = inngest.createFunction(
    { id: 'run-drive', triggers: [{ event: EVENT_RUN_DRIVE }], retries: 2 },
    async ({ event, step }) => {
      const runId = (event.data as { runId: string }).runId;
      return step.run('drive', () => getService().drive(runId));
    },
  );
  const reconcile = inngest.createFunction(
    { id: 'run-reconcile', triggers: [{ cron: '*/5 * * * *' }], retries: 0 },
    async ({ step }) => {
      const count = await step.run('sweep', () => getService().reconcile());
      return { reconciled: count };
    },
  );
  return [drive, reconcile];
}
