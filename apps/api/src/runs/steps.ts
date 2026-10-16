import {
  DRAFT_STEP,
  PROPOSE_STEP,
  REVISE_STEP,
  SAVE_STEP,
  deliverableHash,
  type HandoffInput,
  type ModelStepResult,
  type Proposal,
} from '../core/handoff-flow.js';
import type { ModelGateway } from '../discussion/gateway.js';
import { ProviderError } from '../discussion/providers/index.js';
import { draftPrompt, revisePrompt, type RolePrompt } from './roles.js';
import type { RunRepository, RunRow } from './repository.js';

/** What a step hands back to the driver: its result plus what to record about how it was made. */
export interface StepResult {
  output: unknown;
  costMicro?: number;
  usage?: unknown;
  prompt?: unknown;
  executions?: number;
}

export type StepImpl = (input: never) => Promise<StepResult>;

export class RunCancelled extends Error {
  override name = 'RunCancelled';
}

export interface StepDeps {
  repo: RunRepository;
  gateway: ModelGateway;
  retryDelayMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls the model for one step. Trouble that may pass (timeout, network, rate limit, 5xx) is
 * retried up to the run's frozen `maxRetries`; attempts are counted in the database, so a restart
 * can never lead to more calls than the limit. When the attempts run out the step ends as a
 * failure value, never as an exception.
 */
async function callModel(
  deps: StepDeps,
  run: RunRow,
  name: string,
  prompt: RolePrompt,
): Promise<StepResult> {
  const max = 1 + run.config.maxRetries;
  for (;;) {
    const attempt = await deps.repo.countAttempt(run.id, name);
    if (attempt > max) {
      const known = (await deps.repo.attemptsOf(run.id))[name];
      const output: ModelStepResult = {
        status: 'failed',
        code: 'provider_unavailable',
        reason: known?.lastError ?? 'The AI could not be reached.',
      };
      return { output, prompt, executions: attempt - 1 };
    }
    if ((await deps.repo.stateOf(run.id)) === 'cancelled') throw new RunCancelled();
    try {
      const r = await deps.gateway.complete(run.config.agentId, prompt);
      const costMicro = r.status === 'failed' ? 0 : (r.costMicro ?? 0);
      const output: ModelStepResult =
        r.status === 'ok'
          ? { status: 'ok', text: r.text, costMicro: r.costMicro }
          : r.status === 'bad'
            ? { status: 'bad', reason: r.reason, text: r.text, costMicro: r.costMicro }
            : r;
      return {
        output,
        costMicro,
        usage: r.status === 'failed' ? null : r.usage,
        prompt,
        executions: attempt,
      };
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      await deps.repo.noteAttemptError(run.id, name, err.message);
      if (attempt < max) await sleep(deps.retryDelayMs);
    }
  }
}

/** The step implementations for one run. Names match the step references in `handoff-flow.ts`. */
export function stepImplsFor(deps: StepDeps, run: RunRow): Record<string, StepImpl> {
  const name = run.config.agentName;
  return {
    [DRAFT_STEP]: (async ({ task }: { task: HandoffInput }) =>
      callModel(deps, run, DRAFT_STEP, draftPrompt(name, task))) as StepImpl,

    [REVISE_STEP]: (async (i: { task: HandoffInput; draft: string; human: string }) =>
      callModel(deps, run, REVISE_STEP, revisePrompt(name, i.task, i.draft, i.human))) as StepImpl,

    [PROPOSE_STEP]: (async (i: { title: string; content: string }) => {
      const output: Proposal = { title: i.title, content: i.content, hash: deliverableHash(i) };
      return { output };
    }) as StepImpl,

    [SAVE_STEP]: (async (i: { title: string; content: string; sourceAssetId: string }) => {
      const saved = await deps.repo.saveDeliverable({
        runId: run.id,
        threadId: run.threadId,
        sourceAssetId: i.sourceAssetId,
        title: i.title,
        content: i.content,
      });
      return { output: saved };
    }) as StepImpl,
  };
}
