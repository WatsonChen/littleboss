import { inngest } from '../inngest/client.js';
import type { Dispatcher } from './dispatcher.js';
import type { DiscussionService } from './service.js';

export const EVENT_AI_CALL = 'littleboss/ai.call.requested';

/** Hands a queued call to Inngest. The event id makes a repeated hand-off of one attempt a no-op. */
export class InngestDispatcher implements Dispatcher {
  async dispatch(messageId: string, attempt: number): Promise<void> {
    await inngest.send({ id: `${messageId}:${attempt}`, name: EVENT_AI_CALL, data: { messageId } });
  }
}

/**
 * Runs one AI call as its own step, so a slow model never holds the request that sent the message.
 * No automatic retries: a failed call is shown to the person, who decides whether to pay again.
 */
export function createAiCallFunction(getService: () => DiscussionService) {
  return inngest.createFunction(
    { id: 'ai-call', triggers: [{ event: EVENT_AI_CALL }], retries: 0 },
    async ({ event, step }) => {
      const messageId = (event.data as { messageId: string }).messageId;
      return step.run('call', () => getService().runCall(messageId));
    },
  );
}

/** Every five minutes: continue discussions whose next turn was never created, and start lost calls. */
export function createDiscussionReconcileFunction(getService: () => DiscussionService) {
  return inngest.createFunction(
    { id: 'discussion-reconcile', triggers: [{ cron: '*/5 * * * *' }], retries: 0 },
    async ({ step }) => step.run('sweep', () => getService().reconcile()),
  );
}
