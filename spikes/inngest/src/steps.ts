import type { AnyStepDef } from '../../../apps/api/src/core/flow';
import type { FlowOutcome } from '../../../apps/api/src/core/flow';
import { calendarSteps } from '../../../apps/api/src/core/flow-steps';
import { EVENTS, inngest } from './client';
import { approvals, externalClient, faults, view } from './runtime';

// Engine-neutral step definitions are registered here by name.
const REGISTRY = new Map<string, AnyStepDef>(calendarSteps.map((s) => [s.name, s as AnyStepDef]));

function crash(): never {
  // Simulates the process dying: no cleanup, no response, nothing recorded afterwards.
  process.exit(137);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs any registered StepDef. Counts every attempt and applies the injected faults. */
export async function runNamedStep(runId: string, stepName: string, input: unknown) {
  const def = REGISTRY.get(stepName);
  if (!def) throw new Error(`unregistered step ${stepName}`);

  if (faults.crashBefore.delete(stepName)) crash();

  await view.bumpExecution(runId, stepName);
  const failures = faults.failAttempts.get(stepName) ?? 0;
  if (failures > 0) {
    faults.failAttempts.set(stepName, failures - 1);
    throw new Error(`injected failure of ${stepName}`);
  }
  if (faults.cancelWhenStepStarts.delete(stepName)) {
    await inngest.send({ name: EVENTS.cancel, data: { runId } });
    // Cancellation is asynchronous in Inngest: give the service a moment to apply it before this
    // step goes on, so "skips later steps" is decided by the cancel and not by a race.
    await sleep(1500);
    await view.markCancelled(runId);
  }

  const out = await def.run(input as never, { external: externalClient });

  if (faults.crashAfter.delete(stepName)) crash();
  await view.markCompleted(runId, stepName);
  return out;
}

export async function checkApproval(runId: string, stepName: string, proposalHash: string) {
  const r = await approvals().resolve({
    runId,
    stepId: stepName,
    currentProposalHash: proposalHash,
  });
  return r.status;
}

export const setActiveState = view.setActiveState;
export async function finishRun(runId: string, outcome: FlowOutcome) {
  if (faults.failFinish > 0) {
    faults.failFinish -= 1;
    throw new Error('injected failure of finish');
  }
  await view.finish(runId, outcome);
}
