import { ApprovalService, InMemoryApprovalRepository } from './approval.js';
import { runEngineContract, type EngineHarness } from './engine-contract.js';
import { FakeExternalService } from './fake-external.js';
import {
  APPROVAL_STEP,
  calendarWriteFlow,
  proposalHashFor,
  type CalendarWriteInput,
  type RunConfig,
} from './flow.js';
import { ReferenceEngine } from './reference-engine.js';

function makeReferenceHarness(): EngineHarness {
  const external = new FakeExternalService();
  const approvals = new ApprovalService(new InMemoryApprovalRepository());
  const engine = new ReferenceEngine({
    approvals,
    flow: (ctx, input) => calendarWriteFlow(ctx, { external }, input as CalendarWriteInput),
  });
  const inputs = new Map<string, CalendarWriteInput>();
  const live: RunConfig = { roleVersion: 'v1', model: 'm1', maxRetries: 2 };

  return {
    external,
    async startRun(runId, input) {
      inputs.set(runId, input);
      await engine.startRun(runId, live, input);
    },
    async submitApproval(runId, decision, hashOverride) {
      const input = inputs.get(runId);
      if (!input) throw new Error(`unknown run ${runId}`);
      const result = await approvals.submit({
        runId,
        stepId: APPROVAL_STEP,
        proposalHash: hashOverride ?? proposalHashFor(input),
        decision,
      });
      await engine.notify(runId);
      return result;
    },
    restart: () => engine.recoverAll(),
    cancel: (runId) => engine.cancel(runId),
    getRun: (runId) => engine.view(runId),
    setLiveConfig(next) {
      // Mutate in place: an engine that keeps a reference instead of a frozen copy would leak this.
      Object.assign(live, next);
    },
    inject: {
      crashBefore: (step) => void engine.faults.crashBefore.add(step),
      crashAfter: (step) => void engine.faults.crashAfter.add(step),
      failAttempts: (step, times) => void engine.faults.failAttempts.set(step, times),
      onStepStart: (step, cb) => void engine.faults.onStepStart.set(step, cb),
    },
  };
}

runEngineContract('reference engine (in-memory)', makeReferenceHarness);
