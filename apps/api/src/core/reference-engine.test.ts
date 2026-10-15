import { describe, expect, it } from 'vitest';
import { ApprovalService, InMemoryApprovalRepository } from './approval.js';
import { runEngineContract, type EngineHarness } from './engine-contract.js';
import { FakeExternalService } from './fake-external.js';
import { calendarSteps } from './flow-steps.js';
import { proposalHashFor } from './proposal.js';
import {
  APPROVAL_STEP,
  calendarWriteFlow,
  type CalendarWriteInput,
  type FlowContext,
  type FlowOutcome,
  type RunConfig,
  type StepDef,
  type AnyStepDef,
} from './flow.js';
import { ReferenceEngine } from './reference-engine.js';

function makeReferenceHarness(): EngineHarness {
  const external = new FakeExternalService();
  const approvals = new ApprovalService(new InMemoryApprovalRepository());
  const engine = new ReferenceEngine({
    approvals,
    flow: (ctx, input) => calendarWriteFlow(ctx, input as CalendarWriteInput),
    env: { external },
    steps: calendarSteps,
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
    getRun: async (runId) => engine.view(runId),
    setLiveConfig(next) {
      // Mutate in place: an engine that keeps a reference instead of a frozen copy would leak this.
      Object.assign(live, next);
    },
    inject: {
      crashBefore: (step) => void engine.faults.crashBefore.add(step),
      crashAfter: (step) => void engine.faults.crashAfter.add(step),
      failAttempts: (step, times) => void engine.faults.failAttempts.set(step, times),
      cancelWhenStepStarts: (step) =>
        void engine.faults.onStepStart.set(step, (runId) => void engine.cancel(runId)),
    },
  };
}

runEngineContract('reference engine (in-memory)', makeReferenceHarness);

describe('reference engine: step data rules', () => {
  const makeEngine = (
    flow: (ctx: FlowContext) => Promise<FlowOutcome>,
    steps: readonly AnyStepDef[] = [],
  ) =>
    new ReferenceEngine({
      approvals: new ApprovalService(new InMemoryApprovalRepository()),
      flow: (ctx) => flow(ctx),
      env: { external: new FakeExternalService() },
      steps,
    });
  const config: RunConfig = { roleVersion: 'v1', model: 'm1', maxRetries: 0 };

  it('fails a run whose step result cannot be serialized', async () => {
    const bad: StepDef<null, unknown> = { name: 'bad', run: async () => undefined };
    const engine = makeEngine(
      async (ctx) => {
        await ctx.step(bad, null);
        return { status: 'rejected' };
      },
      [bad as AnyStepDef],
    );
    await engine.startRun('r1', config, null);
    const view = engine.view('r1');
    expect(view.state).toBe('failed');
    expect(view.outcome).toMatchObject({ status: 'failed' });
  });

  it('gives the same value on first run and on replay (no hidden in-memory state)', async () => {
    const stamp: StepDef<null, { at: Date }> = {
      name: 'stamp',
      run: async () => ({ at: new Date(0) }),
    };
    const seen: unknown[] = [];
    const engine = makeEngine(
      async (ctx) => {
        seen.push((await ctx.step(stamp, null)).at);
        await ctx.waitForApproval('gate', 'h');
        return { status: 'rejected' };
      },
      [stamp as AnyStepDef],
    );
    await engine.startRun('r1', config, null);
    await engine.recoverAll();
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe('1970-01-01T00:00:00.000Z'); // a Date comes back as its JSON string
    expect(seen[1]).toEqual(seen[0]);
  });
});
