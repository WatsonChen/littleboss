import { inngest } from '../inngest/client.js';
import type { CaptureEngine, CaptureService } from './service.js';

export const EVENT_CAPTURE_PARSE = 'littleboss/capture.parse';

/** Hands the capture to Inngest. The event id makes a repeated kick of the same moment a no-op. */
export class InngestCaptureEngine implements CaptureEngine {
  async kick(captureId: string, key: string): Promise<void> {
    await inngest.send({ id: key, name: EVENT_CAPTURE_PARSE, data: { captureId } });
  }
}

/** One function reads a capture; a cron sweeps every five minutes for ones nobody is working on. */
export function createCaptureFunctions(getService: () => CaptureService) {
  const parse = inngest.createFunction(
    { id: 'capture-parse', triggers: [{ event: EVENT_CAPTURE_PARSE }], retries: 2 },
    async ({ event, step }) => {
      const captureId = (event.data as { captureId: string }).captureId;
      return step.run('parse', () => getService().run(captureId));
    },
  );
  const reconcile = inngest.createFunction(
    { id: 'capture-reconcile', triggers: [{ cron: '*/5 * * * *' }], retries: 0 },
    async ({ step }) => {
      const count = await step.run('sweep', () => getService().reconcile());
      return { reconciled: count };
    },
  );
  return [parse, reconcile];
}
