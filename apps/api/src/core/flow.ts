import type { ExternalActionResult, ExternalClient } from './external-action.js';

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
 * Flow code must stay free of Node built-ins and I/O: some engines run it in a sandbox. It reaches
 * the outside world only through `ctx.step(ref, ...)`.
 *
 * A step is a named, top-level operation with JSON-serializable input and output, and no captured
 * variables. This shape works for engines that run steps in a separate invocation (Vercel
 * Workflows) as well as for engines that re-run the whole function (Inngest).
 */
export interface StepRef<I, O> {
  readonly name: string;
  /** Phantom fields: carry the types only, never set at runtime. */
  readonly __in?: I;
  readonly __out?: O;
}

export interface StepDef<I, O> extends StepRef<I, O> {
  readonly name: string;
  run(input: I, env: StepEnv): Promise<O>;
}

/** A step definition of any input/output type, for registries that hold several kinds. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyStepDef = StepDef<any, unknown>;

/**
 * The only surface a workflow may use. Every engine adapter implements this.
 * Rules for flow code: be deterministic, and put every side effect inside `step`.
 */
export interface FlowContext {
  readonly runId: string;
  readonly config: Readonly<RunConfig>;
  /** Run the step at most once successfully; on replay return the recorded result. */
  step<I, O>(ref: StepRef<I, O>, input: I): Promise<O>;
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

export const PREPARE_STEP = 'prepare';
export const NOTIFY_STEP = 'notify';

/** A reference to a step by name only. Flow code uses these; the implementation is registered elsewhere. */
export const prepareRef = { name: PREPARE_STEP } as StepRef<
  { input: CalendarWriteInput; roleVersion: string },
  { hash: string; roleVersion: string }
>;
export const writeCalendarRef = { name: WRITE_STEP } as StepRef<
  { idempotencyKey: string; payload: CalendarWriteInput },
  ExternalActionResult
>;
export const notifyRef = { name: NOTIFY_STEP } as StepRef<{ runId: string }, boolean>;

/**
 * M2's second acceptance flow in miniature: propose, wait for approval, write once, notify.
 * Engine-neutral: it only talks to `FlowContext`, and its steps are top-level `StepDef`s.
 */
export async function calendarWriteFlow(
  ctx: FlowContext,
  input: CalendarWriteInput,
): Promise<FlowOutcome> {
  const proposal = await ctx.step(prepareRef, { input, roleVersion: ctx.config.roleVersion });

  const decision = await ctx.waitForApproval(APPROVAL_STEP, proposal.hash);
  if (decision === 'rejected') return { status: 'rejected' };
  if (decision === 'stale') return { status: 'needs_reapproval' };

  const result = await ctx.step(writeCalendarRef, {
    idempotencyKey: `${ctx.runId}:${WRITE_STEP}`,
    payload: input,
  });

  await ctx.step(notifyRef, { runId: ctx.runId });

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
