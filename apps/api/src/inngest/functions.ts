import { inngest } from './client.js';

export const EVENT_PING = 'littleboss/ping';

/** Connectivity check only: proves Inngest can reach this API and run a step. No business logic. */
export const ping = inngest.createFunction(
  { id: 'ping', triggers: [{ event: EVENT_PING }], retries: 0 },
  async ({ step }) => {
    const at = await step.run('stamp', () => new Date().toISOString());
    return { ok: true, at };
  },
);

export const functions = [ping];
