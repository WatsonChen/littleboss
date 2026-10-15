import type { ApprovalService } from './approval.js';
import type {
  ApprovalOutcome,
  FlowContext,
  FlowOutcome,
  RunConfig,
  StepDef,
  StepEnv,
} from './flow.js';

/**
 * In-memory reference engine with journal-and-replay semantics (the model used by durable
 * execution engines). It exists to prove that our flow code is replay-safe and to give the
 * contract tests something to run against. It is NOT for production.
 */

export type RunState =
  | 'running'
  | 'waiting_approval'
  | 'succeeded'
  | 'rejected'
  | 'needs_reapproval'
  | 'failed'
  | 'unknown'
  | 'cancelled';

const ACTIVE: ReadonlySet<RunState> = new Set(['running', 'waiting_approval']);

export class SimulatedCrash extends Error {
  override name = 'SimulatedCrash';
}
class Suspend extends Error {}
class CancelledSignal extends Error {}
class StepFailed extends Error {}

interface RunRecord {
  id: string;
  config: Readonly<RunConfig>;
  input: unknown;
  /** JSON text of each recorded step result, exactly what a durable store would hold. */
  journal: Map<string, string>;
  executions: Map<string, number>;
  state: RunState;
  outcome?: FlowOutcome;
  cancelRequested: boolean;
}

export interface RunView {
  state: RunState;
  outcome: FlowOutcome | undefined;
  completedSteps: string[];
  stepExecutions: Record<string, number>;
  config: Readonly<RunConfig>;
}

type Flow = (ctx: FlowContext, input: unknown) => Promise<FlowOutcome>;

export class ReferenceEngine {
  private runs = new Map<string, RunRecord>();
  readonly faults = {
    crashBefore: new Set<string>(),
    crashAfter: new Set<string>(),
    /** step -> number of upcoming attempts that fail before the step function runs */
    failAttempts: new Map<string, number>(),
    onStepStart: new Map<string, (runId: string) => void>(),
  };

  constructor(private readonly deps: { approvals: ApprovalService; flow: Flow; env: StepEnv }) {}

  /** Idempotent: starting an existing run id returns the existing run. Config is frozen here. */
  async startRun(runId: string, config: RunConfig, input: unknown): Promise<void> {
    if (!this.runs.has(runId)) {
      this.runs.set(runId, {
        id: runId,
        config: Object.freeze({ ...config }),
        input,
        journal: new Map(),
        executions: new Map(),
        state: 'running',
        cancelRequested: false,
      });
    }
    await this.drive(runId);
  }

  /** Re-drive a run, e.g. after a decision arrived. Harmless for finished runs. */
  async notify(runId: string): Promise<void> {
    await this.drive(runId);
  }

  /** What an engine does after the process comes back: resume every unfinished run. */
  async recoverAll(): Promise<void> {
    for (const run of [...this.runs.values()]) {
      if (ACTIVE.has(run.state)) await this.drive(run.id);
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run || !ACTIVE.has(run.state)) return;
    run.cancelRequested = true;
    // A run that is executing right now stops at its next step boundary; a waiting run stops now.
    if (run.state === 'waiting_approval') await this.drive(runId);
  }

  view(runId: string): RunView {
    const run = this.mustGet(runId);
    return {
      state: run.state,
      outcome: run.outcome,
      completedSteps: [...run.journal.keys()],
      stepExecutions: Object.fromEntries(run.executions),
      config: run.config,
    };
  }

  private mustGet(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`unknown run ${runId}`);
    return run;
  }

  private async drive(runId: string): Promise<void> {
    const run = this.mustGet(runId);
    if (!ACTIVE.has(run.state)) return;
    if (run.cancelRequested && run.state === 'waiting_approval') {
      run.state = 'cancelled';
      return;
    }
    run.state = 'running'; // executing now; a crash from here on leaves the run "running"
    try {
      const outcome = await this.deps.flow(this.makeContext(run), run.input);
      run.outcome = outcome;
      run.state = outcome.status;
    } catch (err) {
      if (err instanceof SimulatedCrash) return; // process died: nothing more is recorded
      if (err instanceof Suspend) run.state = 'waiting_approval';
      else if (err instanceof CancelledSignal) run.state = 'cancelled';
      else if (err instanceof StepFailed) {
        run.state = 'failed';
        run.outcome = { status: 'failed', reason: err.message };
      } else throw err;
    }
  }

  private makeContext(run: RunRecord): FlowContext {
    return {
      runId: run.id,
      config: run.config,

      step: async <I, O>(def: StepDef<I, O>, input: I): Promise<O> => {
        const name = def.name;
        const recorded = run.journal.get(name);
        if (recorded !== undefined) return JSON.parse(recorded) as O;
        if (run.cancelRequested) throw new CancelledSignal();
        if (this.faults.crashBefore.delete(name)) throw new SimulatedCrash();
        this.faults.onStepStart.get(name)?.(run.id);

        const attempts = 1 + run.config.maxRetries;
        let lastError: unknown;
        for (let i = 0; i < attempts; i += 1) {
          run.executions.set(name, (run.executions.get(name) ?? 0) + 1);
          try {
            const pending = this.faults.failAttempts.get(name) ?? 0;
            if (pending > 0) {
              this.faults.failAttempts.set(name, pending - 1);
              throw new Error(`injected failure in ${name}`);
            }
            // Input and output must survive JSON, like in an engine that runs steps elsewhere.
            const value = await def.run(JSON.parse(JSON.stringify(input)) as I, this.deps.env);
            const text = JSON.stringify(value);
            if (text === undefined) throw new Error(`${name}: result is not JSON-serializable`);
            // The effect happened, but the process dies before the result is recorded.
            if (this.faults.crashAfter.delete(name)) throw new SimulatedCrash();
            run.journal.set(name, text);
            return JSON.parse(text) as O;
          } catch (err) {
            if (err instanceof SimulatedCrash) throw err;
            lastError = err;
          }
        }
        const reason = lastError instanceof Error ? lastError.message : String(lastError);
        throw new StepFailed(`${name} failed after ${attempts} attempts: ${reason}`);
      },

      waitForApproval: async (stepName: string, proposalHash: string): Promise<ApprovalOutcome> => {
        const key = `approval:${stepName}`;
        const recordedDecision = run.journal.get(key);
        if (recordedDecision !== undefined) return JSON.parse(recordedDecision) as ApprovalOutcome;
        if (run.cancelRequested) throw new CancelledSignal();
        const res = await this.deps.approvals.resolve({
          runId: run.id,
          stepId: stepName,
          currentProposalHash: proposalHash,
        });
        if (res.status === 'pending') throw new Suspend();
        run.journal.set(key, JSON.stringify(res.status));
        return res.status;
      },
    };
  }
}
