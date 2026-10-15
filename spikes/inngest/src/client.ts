import { Inngest } from 'inngest';

/** Talks to the Inngest dev server (a separate process that survives our app restarts). */
export const inngest = new Inngest({
  id: 'littleboss-spike',
  isDev: true,
  baseUrl: process.env.INNGEST_BASE_URL ?? 'http://127.0.0.1:8288',
});

export const EVENTS = {
  start: 'littleboss/run.requested',
  wake: 'littleboss/approval.decided',
  cancel: 'littleboss/run.cancelled',
} as const;
