import type { RunOutcome } from '@littleboss/shared';
import type { ApprovalService } from '../core/approval.js';
import type { ApprovalOutcome, StepRef } from '../core/flow.js';
import {
  APPROVE_STEP,
  HUMAN_STEP,
  handoffFlow,
  type HandoffContext,
  type HandoffOutcome,
} from '../core/handoff-flow.js';
import type { ModelGateway } from '../discussion/gateway.js';
import { RunRepository, type RunRow, type StepRow } from './repository.js';
import { RunCancelled, stepImplsFor } from './steps.js';

class Suspend extends Error {}

export type DriveResult =
  /** Someone else is driving this run right now. */
  | 'busy'
  /** The run is waiting for the person. */
  | 'waiting'
  | 'finished'
  /** The run does not exist or had already finished. */
  | 'idle';

export interface DriverConfig {
  /** How long one driver may hold a run before another may take over. Longer than any one step. */
  leaseMs: number;
  retryDelayMs: number;
}

export const DEFAULT_DRIVER_CONFIG: DriverConfig = { leaseMs: 6 * 60_000, retryDelayMs: 1_500 };

/**
 * Drives a run through `handoffFlow` by replay: every finished step is stored in `run_steps`, so
 * driving again after a pause, a restart or a crash skips finished work and carries on. Waiting
 * for the person is not holding a process: the driver records what it waits for and stops; an
 * answer (or the reconcile sweep) starts it again.
 *
 * Engine-neutral: Inngest, a cron or a test can call `drive()`; the lease keeps two callers from
 * working on the same run at once.
 */
export class RunDriver {
  private readonly cfg: DriverConfig;

  constructor(
    private readonly d: {
      repo: RunRepository;
      gateway: ModelGateway;
      approvals: ApprovalService;
      config?: Partial<DriverConfig>;
    },
  ) {
    this.cfg = { ...DEFAULT_DRIVER_CONFIG, ...d.config };
  }

  async drive(runId: string): Promise<DriveResult> {
    // After a pause, the answer may have arrived while we were still finishing the last pass
    // (its wake-up found us busy), so check once more before giving up the run.
    for (let pass = 0; pass < 8; pass += 1) {
      const run = await this.d.repo.acquireLease(runId, this.cfg.leaseMs);
      if (!run) {
        const state = await this.d.repo.stateOf(runId);
        if (state === null) return 'idle';
        return ['running', 'waiting_input', 'waiting_approval'].includes(state) ? 'busy' : 'idle';
      }
      let result: 'waiting' | 'finished';
      try {
        result = await this.once(run);
      } finally {
        await this.d.repo.releaseLease(runId);
      }
      if (result === 'finished') return 'finished';
      if (!(await this.canProceed(run.id))) return 'waiting';
    }
    return 'waiting';
  }

  /** True when the thing the run waits for has arrived. */
  private async canProceed(runId: string): Promise<boolean> {
    const state = await this.d.repo.stateOf(runId);
    if (state === 'running') return true;
    if (state === 'waiting_input') {
      return (await this.d.repo.getInput(RunRepository.inputKey(runId, HUMAN_STEP))) !== null;
    }
    if (state === 'waiting_approval') {
      const res = await this.d.approvals.resolve({
        runId,
        stepId: APPROVE_STEP,
        currentProposalHash: '',
      });
      return res.status !== 'pending';
    }
    return false;
  }

  private async once(run: RunRow): Promise<'waiting' | 'finished'> {
    const { repo, approvals } = this.d;
    await repo.setActiveState(run.id, 'running');
    const memo = new Map<string, StepRow>((await repo.getSteps(run.id)).map((s) => [s.name, s]));
    const impls = stepImplsFor(
      { repo, gateway: this.d.gateway, retryDelayMs: this.cfg.retryDelayMs },
      run,
    );

    const ensureActive = async () => {
      if ((await repo.stateOf(run.id)) === 'cancelled') throw new RunCancelled();
    };

    const ctx: HandoffContext = {
      runId: run.id,
      config: { roleVersion: run.config.roleVersion, model: run.config.model, maxRetries: run.config.maxRetries },

      step: async <I, O>(ref: StepRef<I, O>, input: I): Promise<O> => {
        const recorded = memo.get(ref.name);
        if (recorded) return recorded.output as O;
        await ensureActive();
        const impl = impls[ref.name];
        if (!impl) throw new Error(`unregistered step ${ref.name}`);
        // Input and output pass through JSON, like in an engine that runs steps elsewhere.
        const r = await impl(JSON.parse(JSON.stringify(input)) as never);
        const row = await repo.recordStep({
          runId: run.id,
          name: ref.name,
          output: r.output,
          usage: r.usage ?? null,
          costMicro: r.costMicro ?? 0,
          prompt: r.prompt ?? null,
          executions: r.executions ?? 1,
        });
        memo.set(ref.name, row);
        return row.output as O;
      },

      waitForInput: async (stepName: string): Promise<string> => {
        await ensureActive();
        const text = await repo.getInput(RunRepository.inputKey(run.id, stepName));
        if (text !== null) return text;
        await repo.setActiveState(run.id, 'waiting_input');
        throw new Suspend();
      },

      waitForApproval: async (stepName: string, proposalHash: string): Promise<ApprovalOutcome> => {
        await ensureActive();
        const res = await approvals.resolve({
          runId: run.id,
          stepId: stepName,
          currentProposalHash: proposalHash,
        });
        if (res.status === 'pending') {
          await repo.setActiveState(run.id, 'waiting_approval');
          throw new Suspend();
        }
        return res.status;
      },
    };

    try {
      const outcome = await handoffFlow(ctx, run.input);
      await repo.finish(run.id, outcome.status, toRunOutcome(outcome));
      return 'finished';
    } catch (err) {
      if (err instanceof Suspend) return 'waiting';
      if (err instanceof RunCancelled) return 'finished';
      throw err; // unexpected (database trouble...): the engine retries; finished steps are kept
    }
  }
}

function toRunOutcome(o: HandoffOutcome): RunOutcome {
  return o;
}
