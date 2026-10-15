import { createHash } from 'node:crypto';
import {
  executeExternalAction,
  type ExternalActionResult,
  type ExternalClient,
} from './external-action.js';

/** Settings frozen when a run starts. Later edits to roles or models never affect a running run. */
export interface RunConfig {
  roleVersion: string;
  model: string;
  /** Extra attempts after the first one, per step. */
  maxRetries: number;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'stale';

/** Everything a step may touch besides its input. Wired once at startup by the engine adapter. */
export interface StepEnv {
  external: ExternalClient;
}

/**
 * A step is a named, top-level operation with JSON-serializable input and output, and no captured
 * variables. This shape works for engines that run steps in a separate invocation (Vercel
 * Workflows) as well as for engines that re-run the whole function (Inngest).
 */
export interface StepDef<I, O> {
  readonly name: string;
  run(input: I, env: StepEnv): Promise<O>;
}

/**
 * The only surface a workflow may use. Every engine adapter implements this.
 * Rules for flow code: be deterministic, and put every side effect inside `step`.
 */
export interface FlowContext {
  readonly runId: string;
  readonly config: Readonly<RunConfig>;
  /** Run the step at most once successfully; on replay return the recorded result. */
  step<I, O>(def: StepDef<I, O>, input: I): Promise<O>;
  /** Suspend the run until a decision exists for this step, bound to `proposalHash`. */
  waitForApproval(stepName: string, proposalHash: string): Promise<ApprovalOutcome>;
}

export type FlowOutcome =
  | { status: 'succeeded'; externalId: string; verified: boolean; roleVersion: string }
  | { status: 'rejected' }
  | { status: 'needs_reapproval' }
  | { status: 'failed'; reason: string }
  | { status: 'unknown'; reason: string };

export interface CalendarWriteInput {
  title: string;
  startsAt: string;
}

export const APPROVAL_STEP = 'approve-calendar';
export const WRITE_STEP = 'write-calendar';

/** Hash of exactly what the person approves: content, destination and action. */
export function proposalHashFor(input: CalendarWriteInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action: 'calendar.create',
        destination: 'google-calendar',
        title: input.title,
        startsAt: input.startsAt,
      }),
    )
    .digest('hex');
}

export const PREPARE_STEP = 'prepare';
export const NOTIFY_STEP = 'notify';

export const prepareStep: StepDef<
  { input: CalendarWriteInput; roleVersion: string },
  { hash: string; roleVersion: string }
> = {
  name: PREPARE_STEP,
  run: async ({ input, roleVersion }) => ({ hash: proposalHashFor(input), roleVersion }),
};

export const writeCalendarStep: StepDef<
  { idempotencyKey: string; payload: CalendarWriteInput },
  ExternalActionResult
> = {
  name: WRITE_STEP,
  run: (input, env) => executeExternalAction(env.external, input),
};

export const notifyStep: StepDef<{ runId: string }, boolean> = {
  name: NOTIFY_STEP,
  run: async () => true,
};

/**
 * M2's second acceptance flow in miniature: propose, wait for approval, write once, notify.
 * Engine-neutral: it only talks to `FlowContext`, and its steps are top-level `StepDef`s.
 */
export async function calendarWriteFlow(
  ctx: FlowContext,
  input: CalendarWriteInput,
): Promise<FlowOutcome> {
  const proposal = await ctx.step(prepareStep, { input, roleVersion: ctx.config.roleVersion });

  const decision = await ctx.waitForApproval(APPROVAL_STEP, proposal.hash);
  if (decision === 'rejected') return { status: 'rejected' };
  if (decision === 'stale') return { status: 'needs_reapproval' };

  const result = await ctx.step(writeCalendarStep, {
    idempotencyKey: `${ctx.runId}:${WRITE_STEP}`,
    payload: input,
  });

  await ctx.step(notifyStep, { runId: ctx.runId });

  if (result.status === 'succeeded') {
    return {
      status: 'succeeded',
      externalId: result.externalId,
      verified: result.verified,
      roleVersion: proposal.roleVersion,
    };
  }
  return result.status === 'failed'
    ? { status: 'failed', reason: result.reason }
    : { status: 'unknown', reason: result.reason };
}
