import type { ApprovalOutcome, FlowContext, StepRef } from './flow.js';
import { createHash } from 'node:crypto';

/**
 * M2 first acceptance flow: a saved conclusion is handed to an AI "executor" role, a person
 * returns something by hand, the executor revises, the person approves, the result is saved.
 *
 * Engine-neutral like `calendarWriteFlow`: it reaches the outside world only through `ctx`.
 * Steps return failures that retrying cannot fix as values ({status:'bad'|'failed'}); only
 * transient trouble is thrown, so the engine retries exactly the cases worth retrying.
 */

export interface HandoffInput {
  conclusion: { assetId: string; version: number; title: string; content: string };
  /** What the person wants done with the conclusion. May be empty. */
  instruction: string;
}

/** A flow context that can also wait for something a person types in. */
export interface HandoffContext extends FlowContext {
  /** Suspend until the person has returned their input for this step; resolves to their text. */
  waitForInput(stepName: string): Promise<string>;
}

export type ModelStepResult =
  | { status: 'ok'; text: string; costMicro: number | null }
  /** The model answered but not usably (cut off, refused, empty). The partial text is kept. */
  | {
      status: 'bad';
      reason: 'truncated' | 'refused' | 'empty';
      text: string;
      costMicro: number | null;
    }
  /** Cannot proceed and retrying will not help (not hired, over budget, bad key...). */
  | { status: 'failed'; code: string; reason: string };

export interface Proposal {
  title: string;
  content: string;
  hash: string;
}

export type HandoffOutcome =
  | { status: 'succeeded'; assetId: string; version: number }
  | { status: 'rejected' }
  | { status: 'needs_reapproval' }
  | { status: 'failed'; code: string; reason: string };

export const DRAFT_STEP = 'draft';
export const HUMAN_STEP = 'human-return';
export const REVISE_STEP = 'revise';
export const PROPOSE_STEP = 'propose';
export const APPROVE_STEP = 'approve-deliverable';
export const SAVE_STEP = 'save-deliverable';

export const draftRef = { name: DRAFT_STEP } as StepRef<{ task: HandoffInput }, ModelStepResult>;
export const reviseRef = { name: REVISE_STEP } as StepRef<
  { task: HandoffInput; draft: string; human: string },
  ModelStepResult
>;
export const proposeRef = { name: PROPOSE_STEP } as StepRef<
  { title: string; content: string },
  Proposal
>;
export const saveRef = { name: SAVE_STEP } as StepRef<
  { idempotencyKey: string; title: string; content: string; sourceAssetId: string },
  { assetId: string; version: number }
>;

/** Hash of exactly what the person approves: content, destination and action. */
export function deliverableHash(p: { title: string; content: string }): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action: 'deliverable.save',
        destination: 'little-boss-assets',
        title: p.title,
        content: p.content,
      }),
    )
    .digest('hex');
}

export async function handoffFlow(
  ctx: HandoffContext,
  input: HandoffInput,
): Promise<HandoffOutcome> {
  const draft = await ctx.step(draftRef, { task: input });
  if (draft.status !== 'ok') return stopped(draft);

  const human = await ctx.waitForInput(HUMAN_STEP);

  const revised = await ctx.step(reviseRef, { task: input, draft: draft.text, human });
  if (revised.status !== 'ok') return stopped(revised);

  const proposal = await ctx.step(proposeRef, {
    title: input.conclusion.title,
    content: revised.text,
  });
  const decision: ApprovalOutcome = await ctx.waitForApproval(APPROVE_STEP, proposal.hash);
  if (decision === 'rejected') return { status: 'rejected' };
  if (decision === 'stale') return { status: 'needs_reapproval' };

  const saved = await ctx.step(saveRef, {
    idempotencyKey: `${ctx.runId}:${SAVE_STEP}`,
    title: proposal.title,
    content: proposal.content,
    sourceAssetId: input.conclusion.assetId,
  });
  return { status: 'succeeded', assetId: saved.assetId, version: saved.version };
}

function stopped(r: Exclude<ModelStepResult, { status: 'ok' }>): HandoffOutcome {
  return r.status === 'failed'
    ? { status: 'failed', code: r.code, reason: r.reason }
    : { status: 'failed', code: r.reason, reason: `The model's reply was unusable (${r.reason}).` };
}
