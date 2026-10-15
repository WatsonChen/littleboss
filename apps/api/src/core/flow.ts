import { createHash } from 'node:crypto';
import { executeExternalAction, type ExternalClient } from './external-action.js';

/** Settings frozen when a run starts. Later edits to roles or models never affect a running run. */
export interface RunConfig {
  roleVersion: string;
  model: string;
  /** Extra attempts after the first one, per step. */
  maxRetries: number;
}

export type ApprovalOutcome = 'approved' | 'rejected' | 'stale';

/**
 * The only surface a workflow may use. Every engine adapter implements this.
 * Rules for flow code: be deterministic, and put every side effect inside `step`.
 */
export interface FlowContext {
  readonly runId: string;
  readonly config: Readonly<RunConfig>;
  /** Run `fn` at most once successfully; on replay return the recorded result. */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
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

/**
 * M2's second acceptance flow in miniature: propose, wait for approval, write once, notify.
 * Engine-neutral: it only talks to `FlowContext`.
 */
export async function calendarWriteFlow(
  ctx: FlowContext,
  deps: { external: ExternalClient },
  input: CalendarWriteInput,
): Promise<FlowOutcome> {
  const proposal = await ctx.step('prepare', async () => ({
    hash: proposalHashFor(input),
    roleVersion: ctx.config.roleVersion,
  }));

  const decision = await ctx.waitForApproval(APPROVAL_STEP, proposal.hash);
  if (decision === 'rejected') return { status: 'rejected' };
  if (decision === 'stale') return { status: 'needs_reapproval' };

  const result = await ctx.step(WRITE_STEP, () =>
    executeExternalAction(deps.external, {
      idempotencyKey: `${ctx.runId}:${WRITE_STEP}`,
      payload: input,
    }),
  );

  await ctx.step('notify', async () => true);

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
