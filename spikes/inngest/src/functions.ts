import {
  calendarWriteFlow,
  type ApprovalOutcome,
  type CalendarWriteInput,
  type FlowContext,
  type FlowOutcome,
  type RunConfig,
} from '../../../apps/api/src/core/flow';
import { EVENTS, inngest } from './client';
import { checkApproval, finishRun, runNamedStep, setActiveState } from './steps';

// How long one wait lasts before we look at our own database again. A decision sent before the
// wait is registered is not seen by the engine, so a bounded wait plus a re-check closes that gap.
const WAIT_TIMEOUT = process.env.SPIKE_WAIT_TIMEOUT ?? '1h';

export const calendarFn = inngest.createFunction(
  {
    id: 'calendar-write',
    triggers: [{ event: EVENTS.start }],
    retries: 2, // 2 retries = 3 attempts in total
    cancelOn: [{ event: EVENTS.cancel, match: 'data.runId' }],
  },
  async ({ event, step }) => {
    const { runId, input, config } = event.data as {
      runId: string;
      input: CalendarWriteInput;
      config: RunConfig;
    };

    const ctx: FlowContext = {
      runId,
      config,
      step: (def, stepInput) =>
        step.run(def.name, () => runNamedStep(runId, def.name, stepInput)) as Promise<never>,
      async waitForApproval(stepName, proposalHash): Promise<ApprovalOutcome> {
        let status = await step.run('check-0', () => checkApproval(runId, stepName, proposalHash));
        if (status === 'pending') {
          await step.run('state-waiting', () => setActiveState(runId, 'waiting_approval'));
          for (let i = 1; status === 'pending'; i += 1) {
            await step.waitForEvent(`wait-${i}`, {
              event: EVENTS.wake,
              timeout: WAIT_TIMEOUT,
              match: 'data.runId',
            });
            status = await step.run(`check-${i}`, () =>
              checkApproval(runId, stepName, proposalHash),
            );
          }
          await step.run('state-running', () => setActiveState(runId, 'running'));
        }
        return status as ApprovalOutcome;
      },
    };

    let outcome: FlowOutcome;
    try {
      outcome = await calendarWriteFlow(ctx, input);
    } catch (err) {
      outcome = { status: 'failed', reason: err instanceof Error ? err.message : String(err) };
    }
    await step.run('finish', () => finishRun(runId, outcome));
    return outcome;
  },
);
