import { createHook, getWorkflowMetadata } from 'workflow';
import {
  calendarWriteFlow,
  type ApprovalOutcome,
  type CalendarWriteInput,
  type FlowContext,
  type FlowOutcome,
  type RunConfig,
} from '../../../apps/api/src/core/flow';
import { checkApproval, finishRun, runNamedStep, setActiveState } from './steps';

export async function calendarWorkflow(
  runId: string,
  input: CalendarWriteInput,
  config: RunConfig,
): Promise<FlowOutcome> {
  'use workflow';
  const { workflowRunId } = getWorkflowMetadata();
  const info = { runId, workflowRunId };

  const ctx: FlowContext = {
    runId,
    config,
    step: (def, stepInput) => runNamedStep(info, def.name, stepInput) as Promise<never>,
    async waitForApproval(stepName, proposalHash): Promise<ApprovalOutcome> {
      let status = await checkApproval(runId, stepName, proposalHash);
      if (status === 'pending') {
        await setActiveState(runId, 'waiting_approval');
        // Order matters: register the hook, then re-check the database. A wake-up sent before the
        // hook exists is not buffered, but the decision itself is already in our database.
        using hook = createHook<{ wake: true }>({ token: `approval:${runId}:${stepName}` });
        status = await checkApproval(runId, stepName, proposalHash);
        if (status === 'pending') {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          for await (const _wake of hook) {
            status = await checkApproval(runId, stepName, proposalHash);
            if (status !== 'pending') break;
          }
        }
        await setActiveState(runId, 'running');
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
  await finishRun(runId, outcome);
  return outcome;
}
