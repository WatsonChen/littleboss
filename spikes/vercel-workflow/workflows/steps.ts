import { getRun } from 'workflow/api';
import type { StepDef } from '../../../apps/api/src/core/flow';
import type { FlowOutcome } from '../../../apps/api/src/core/flow';
import { calendarSteps } from '../../../apps/api/src/core/flow-steps';
import { approvals, externalClient, faults, view } from '../src/runtime';

export interface StepInfo {
  runId: string;
  workflowRunId: string;
}

// Engine-neutral step definitions are registered here by name.
const REGISTRY = new Map<string, StepDef<never, unknown>>(
  calendarSteps.map((s) => [s.name, s as StepDef<never, unknown>]),
);

function crash(): never {
  // Simulates the process dying: no cleanup, no response, nothing recorded afterwards.
  process.exit(137);
}

/**
 * One generic engine step that runs any registered StepDef. Counts every attempt, applies the
 * injected faults, records completion. maxRetries = 2 means 3 attempts in total.
 */
export async function runNamedStep(info: StepInfo, stepName: string, input: unknown) {
  'use step';
  const def = REGISTRY.get(stepName);
  if (!def) throw new Error(`unregistered step ${stepName}`);

  // The process dies before the step starts, so this attempt is not counted.
  if (faults.crashBefore.delete(stepName)) crash();

  await view.bumpExecution(info.runId, stepName);
  const failures = faults.failAttempts.get(stepName) ?? 0;
  if (failures > 0) {
    faults.failAttempts.set(stepName, failures - 1);
    throw new Error(`injected failure of ${stepName}`);
  }
  if (faults.cancelWhenStepStarts.delete(stepName)) {
    await view.markCancelled(info.runId);
    await getRun(info.workflowRunId).cancel();
  }

  const out = await def.run(input as never, { external: externalClient });

  if (faults.crashAfter.delete(stepName)) crash();
  await view.markCompleted(info.runId, stepName);
  return out;
}
runNamedStep.maxRetries = 2;

// Bookkeeping steps: not counted as flow steps.
export async function checkApproval(runId: string, stepName: string, proposalHash: string) {
  'use step';
  const r = await approvals().resolve({
    runId,
    stepId: stepName,
    currentProposalHash: proposalHash,
  });
  return r.status;
}

export async function setActiveState(runId: string, state: 'running' | 'waiting_approval') {
  'use step';
  await view.setActiveState(runId, state);
}

export async function finishRun(runId: string, outcome: FlowOutcome) {
  'use step';
  await view.finish(runId, outcome);
}
