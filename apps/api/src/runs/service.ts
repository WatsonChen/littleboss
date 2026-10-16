import {
  type CreateRunRequest,
  type CreateRunResponse,
  type RunPending,
  type RunStepView,
  type RunView,
  type SubmitApprovalRequest,
  type SubmitInputRequest,
  type SubmitResponse,
} from '@littleboss/shared';
import type { ApprovalService } from '../core/approval.js';
import {
  APPROVE_STEP,
  DRAFT_STEP,
  HUMAN_STEP,
  PROPOSE_STEP,
  REVISE_STEP,
  SAVE_STEP,
  type HandoffInput,
  type ModelStepResult,
  type Proposal,
} from '../core/handoff-flow.js';
import { HttpError } from '../discussion/errors.js';
import type { ModelGateway } from '../discussion/gateway.js';
import type { Pricing } from '../discussion/pricing.js';
import type { Roster } from '../discussion/roster.js';
import type { DriveResult, RunDriver } from './driver.js';
import {
  ACTIVE_STATES,
  RunRepository,
  type RunConfigFrozen,
  type RunRow,
  type StepRow,
} from './repository.js';
import { draftPrompt, EXECUTOR_ROLE_VERSION, revisePrompt } from './roles.js';

/** Starts or wakes a run somewhere that can drive it. `key` makes a repeated request a no-op. */
export interface RunEngine {
  kick(runId: string, key: string): Promise<void>;
  /** Lets the service hand over how a run is driven (used by the in-process engine). */
  bind?(drive: (runId: string) => Promise<unknown>): void;
}

export interface RunServiceConfig {
  maxInputTokens: number;
  maxRetries: number;
  /** A run nobody has touched for this long is looked at again by the reconcile sweep. */
  reconcileIdleMs: number;
}

export const DEFAULT_RUN_CONFIG: RunServiceConfig = {
  maxInputTokens: 100_000,
  maxRetries: 1,
  reconcileIdleMs: 2 * 60_000,
};

export interface RunDeps {
  repo: RunRepository;
  roster: Roster;
  gateway: ModelGateway;
  pricing: Pricing;
  approvals: ApprovalService;
  driver: RunDriver;
  engine: RunEngine;
  config?: Partial<RunServiceConfig>;
  log?: (msg: string, err?: unknown) => void;
}

const LABELS: Record<string, string> = {
  [DRAFT_STEP]: '起草',
  [HUMAN_STEP]: '你帶回結果',
  [REVISE_STEP]: '修訂',
  [PROPOSE_STEP]: '整理成品',
  [APPROVE_STEP]: '你核准',
  [SAVE_STEP]: '存成成品',
};
const ORDER = [DRAFT_STEP, HUMAN_STEP, REVISE_STEP, PROPOSE_STEP, APPROVE_STEP, SAVE_STEP];

const INPUT_PROMPT =
  '把草稿帶去你要用的地方（例如別的 AI 或工具），再把結果或你的修改意見貼回來。沒有要補充也可以直接送出。';

const isOkText = (o: unknown): string | null => {
  const r = o as ModelStepResult | undefined;
  return r && (r.status === 'ok' || r.status === 'bad') ? r.text : null;
};

export class RunService {
  private readonly cfg: RunServiceConfig;
  private readonly repo: RunRepository;

  constructor(private readonly d: RunDeps) {
    this.cfg = { ...DEFAULT_RUN_CONFIG, ...d.config };
    this.repo = d.repo;
    d.engine.bind?.((id) => this.drive(id));
  }

  /** Called by the engine. */
  drive(runId: string): Promise<DriveResult> {
    return this.d.driver.drive(runId);
  }

  // ---- create ---------------------------------------------------------------------------------

  async create(threadId: string, req: CreateRunRequest): Promise<CreateRunResponse> {
    const agent = this.d.roster.get(req.agentId);
    if (!agent.hired) {
      throw new HttpError(400, 'agent_not_hired', `Not hired yet: ${req.agentId}.`, {
        agents: [req.agentId],
      });
    }
    const conclusion = await this.repo.getConclusion(threadId, req.assetId, req.version);
    if (!conclusion) {
      throw new HttpError(404, 'conclusion_not_found', 'No such saved conclusion in this discussion.');
    }
    const input: HandoffInput = { conclusion, instruction: req.instruction };
    const config: RunConfigFrozen = {
      roleId: 'executor',
      roleVersion: EXECUTOR_ROLE_VERSION,
      agentId: req.agentId,
      agentName: agent.displayName,
      model: agent.model,
      maxRetries: this.cfg.maxRetries,
      maxOutputTokens: this.d.pricing.maxOutputTokens,
    };

    // What the run may cost: the draft now, and the revision later (sized for the longest draft
    // and a long return from the person).
    const draft = draftPrompt(agent.displayName, input);
    const revise = revisePrompt(
      agent.displayName,
      input,
      'x'.repeat(this.d.pricing.maxOutputTokens * 2),
      'x'.repeat(4_000),
    );
    const inputTokens = this.d.pricing.estimateInputTokens(draft.system + draft.user);
    if (inputTokens > this.cfg.maxInputTokens) {
      throw new HttpError(413, 'context_too_large', 'This conclusion is too long to hand over.', {
        inputTokens,
        limit: this.cfg.maxInputTokens,
      });
    }
    const reservedMicro =
      this.d.gateway.estimateCostMicro(req.agentId, draft.system + draft.user) +
      this.d.gateway.estimateCostMicro(req.agentId, revise.system + revise.user);

    const { run, created } = await this.repo.create(
      {
        threadId,
        kind: 'handoff',
        title: conclusion.title,
        config,
        input,
        reservedMicro,
        clientRequestId: req.clientRequestId,
      },
      ({ limitMicro, spentMicro }) => {
        if (spentMicro + reservedMicro > limitMicro) {
          throw new HttpError(402, 'over_budget', 'This would go over the discussion budget.', {
            totalMicro: reservedMicro,
            spentMicro,
            budgetLimitMicro: limitMicro,
          });
        }
      },
    );
    if (created) await this.kick(run.id, `${run.id}:start`);
    return { deduplicated: !created, run: await this.view(run) };
  }

  // ---- read -----------------------------------------------------------------------------------

  async get(id: string): Promise<RunView> {
    return this.view(await this.mustGet(id));
  }

  async listForThread(threadId: string): Promise<RunView[]> {
    const runs = await this.repo.listForThread(threadId);
    return Promise.all(runs.map((r) => this.view(r)));
  }

  async listWaiting(): Promise<RunView[]> {
    const runs = await this.repo.listWaiting();
    return Promise.all(runs.map((r) => this.view(r)));
  }

  // ---- what the person does -------------------------------------------------------------------

  async submitInput(id: string, req: SubmitInputRequest): Promise<SubmitResponse> {
    const run = await this.mustGet(id);
    if (req.stepName !== HUMAN_STEP) {
      throw new HttpError(400, 'unknown_step', 'This run is not waiting for that.');
    }
    const key = RunRepository.inputKey(run.id, HUMAN_STEP);
    if ((await this.repo.getInput(key)) !== null) {
      return { accepted: false, run: await this.view(run) };
    }
    if (run.state !== 'waiting_input') {
      throw new HttpError(409, 'not_waiting_input', 'This run is not waiting for your input.');
    }
    const stored = await this.repo.insertInput(key, req.text);
    if (stored) await this.kick(run.id, `${run.id}:input:${HUMAN_STEP}`);
    return { accepted: stored, run: await this.view(await this.mustGet(id)) };
  }

  async submitApproval(id: string, req: SubmitApprovalRequest): Promise<SubmitResponse> {
    const run = await this.mustGet(id);
    if (req.stepName !== APPROVE_STEP) {
      throw new HttpError(400, 'unknown_step', 'This run is not waiting for that.');
    }
    const resolved = await this.d.approvals.resolve({
      runId: run.id,
      stepId: APPROVE_STEP,
      currentProposalHash: req.proposalHash,
    });
    if (resolved.status !== 'pending') {
      // A decision exists already: the first one stands.
      return { accepted: false, run: await this.view(run) };
    }
    if (run.state !== 'waiting_approval') {
      throw new HttpError(409, 'not_waiting_approval', 'This run is not waiting for your approval.');
    }
    const proposal = (await this.repo.getSteps(run.id)).find((s) => s.name === PROPOSE_STEP)
      ?.output as Proposal | undefined;
    if (!proposal || proposal.hash !== req.proposalHash) {
      throw new HttpError(
        409,
        'stale_proposal',
        'What you were shown is no longer what would be saved. Look at it again.',
      );
    }
    const result = await this.d.approvals.submit({
      runId: run.id,
      stepId: APPROVE_STEP,
      proposalHash: req.proposalHash,
      decision: req.decision,
    });
    if (result === 'accepted') await this.kick(run.id, `${run.id}:approval:${APPROVE_STEP}`);
    return { accepted: result === 'accepted', run: await this.view(await this.mustGet(id)) };
  }

  /** Stops a run that is still active. A step already underway finishes, but nothing new starts. */
  async cancel(id: string): Promise<RunView> {
    const run = await this.mustGet(id);
    if (ACTIVE_STATES.includes(run.state)) {
      await this.repo.finish(run.id, 'cancelled', { status: 'cancelled' });
    }
    return this.get(id);
  }

  // ---- reconcile ------------------------------------------------------------------------------

  /**
   * Looks at active runs nobody is driving (a lost wake-up, a worker that died) and starts them
   * again. Driving a run that has nothing to do is harmless.
   */
  async reconcile(now = Date.now()): Promise<number> {
    const runs = await this.repo.listToReconcile(this.cfg.reconcileIdleMs);
    for (const run of runs) {
      await this.repo.touchReconciled(run.id);
      await this.kick(run.id, `${run.id}:reconcile:${Math.floor(now / this.cfg.reconcileIdleMs)}`);
    }
    return runs.length;
  }

  // ---- internals ------------------------------------------------------------------------------

  private async kick(runId: string, key: string): Promise<void> {
    try {
      await this.d.engine.kick(runId, key);
    } catch (err) {
      // The state is saved; the reconcile sweep will pick the run up.
      this.d.log?.('run kick failed', err);
    }
  }

  private async mustGet(id: string): Promise<RunRow> {
    const run = await this.repo.get(id);
    if (!run) throw new HttpError(404, 'run_not_found', 'No such task.');
    return run;
  }

  private async view(run: RunRow): Promise<RunView> {
    const [steps, attempts, input] = await Promise.all([
      this.repo.getSteps(run.id),
      this.repo.attemptsOf(run.id),
      this.repo.getInput(RunRepository.inputKey(run.id, HUMAN_STEP)),
    ]);
    const byName = new Map<string, StepRow>(steps.map((s) => [s.name, s]));
    const approval = await this.d.approvals.resolve({
      runId: run.id,
      stepId: APPROVE_STEP,
      currentProposalHash: '',
    });
    const active = ACTIVE_STATES.includes(run.state);

    const done = (name: string): boolean =>
      name === HUMAN_STEP ? input !== null : name === APPROVE_STEP ? approval.status !== 'pending' : byName.has(name);
    const textOf = (name: string): string | null => {
      const row = byName.get(name);
      if (name === HUMAN_STEP) return input;
      if (name === DRAFT_STEP || name === REVISE_STEP) return isOkText(row?.output);
      if (name === PROPOSE_STEP) return (row?.output as Proposal | undefined)?.content ?? null;
      return null;
    };

    const stepViews: RunStepView[] = [];
    let currentTaken = false;
    for (const name of ORDER) {
      const finished = done(name);
      let status: RunStepView['status'] | null = finished ? 'done' : null;
      if (!finished && active && !currentTaken) {
        currentTaken = true;
        status = run.state === 'running' ? 'active' : 'waiting';
      }
      if (!status) continue;
      stepViews.push({
        name,
        label: LABELS[name] ?? name,
        status,
        costMicro: byName.get(name)?.costMicro ?? 0,
        attempts: attempts[name]?.count ?? (byName.get(name)?.executions ?? 0),
        text: textOf(name),
      });
    }

    let pending: RunPending | null = null;
    if (run.state === 'waiting_input') {
      pending = {
        kind: 'input',
        stepName: HUMAN_STEP,
        prompt: INPUT_PROMPT,
        draft: textOf(DRAFT_STEP) ?? '',
      };
    } else if (run.state === 'waiting_approval') {
      const p = byName.get(PROPOSE_STEP)?.output as Proposal | undefined;
      if (p) pending = { kind: 'approval', stepName: APPROVE_STEP, proposal: p };
    }

    const costMicro = steps.reduce((sum, s) => sum + s.costMicro, 0);
    return {
      id: run.id,
      threadId: run.threadId,
      title: run.title,
      state: run.state,
      config: {
        agentId: run.config.agentId,
        model: run.config.model,
        roleVersion: run.config.roleVersion,
      },
      instruction: run.input.instruction,
      conclusion: {
        assetId: run.input.conclusion.assetId,
        version: run.input.conclusion.version,
        title: run.input.conclusion.title,
      },
      outcome: run.outcome,
      pending,
      steps: stepViews,
      costMicro,
      reservedMicro: active ? run.reservedMicro : 0,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      finishedAt: run.finishedAt ? run.finishedAt.toISOString() : null,
    };
  }
}
