import { z } from 'zod';
import { AgentId } from './discussion.js';

/** Run contracts (M2), shared by apps/web and apps/api. */

export const RunState = z.enum([
  'running',
  'waiting_input',
  'waiting_approval',
  'succeeded',
  'rejected',
  'needs_reapproval',
  'failed',
  'cancelled',
]);
export type RunState = z.infer<typeof RunState>;

export const RunPending = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('input'),
    stepName: z.string(),
    /** What the person is asked to bring back. */
    prompt: z.string(),
    /** The AI's draft the person is responding to. */
    draft: z.string(),
  }),
  z.object({
    kind: z.literal('approval'),
    stepName: z.string(),
    proposal: z.object({ title: z.string(), content: z.string(), hash: z.string() }),
  }),
]);
export type RunPending = z.infer<typeof RunPending>;

export const RunStepView = z.object({
  name: z.string(),
  label: z.string(),
  /** Steps that finished, plus the one in progress or waiting. */
  status: z.enum(['done', 'active', 'waiting']),
  costMicro: z.number(),
  attempts: z.number().int(),
  /** The text this step produced, when it produced any. */
  text: z.string().nullable(),
});
export type RunStepView = z.infer<typeof RunStepView>;

export const RunOutcome = z.union([
  z.object({ status: z.literal('succeeded'), assetId: z.string(), version: z.number().int() }),
  z.object({ status: z.literal('rejected') }),
  z.object({ status: z.literal('needs_reapproval') }),
  z.object({ status: z.literal('failed'), code: z.string(), reason: z.string() }),
  z.object({ status: z.literal('cancelled') }),
]);
export type RunOutcome = z.infer<typeof RunOutcome>;

export const RunView = z.object({
  id: z.string(),
  threadId: z.string().nullable(),
  title: z.string(),
  state: RunState,
  /** The settings frozen when the run started. */
  config: z.object({
    agentId: AgentId,
    model: z.string(),
    roleVersion: z.string(),
  }),
  instruction: z.string(),
  conclusion: z.object({ assetId: z.string(), version: z.number().int(), title: z.string() }),
  outcome: RunOutcome.nullable(),
  pending: RunPending.nullable(),
  steps: z.array(RunStepView),
  /** What the run has really cost so far, and what is set aside for it while it is active. */
  costMicro: z.number(),
  reservedMicro: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type RunView = z.infer<typeof RunView>;

export const CreateRunRequest = z.object({
  /** A fresh id per tap. Sending the same id again returns the first run and starts nothing. */
  clientRequestId: z.string().min(8).max(100),
  /** The saved conclusion to hand over. Without `version`, its latest version is used. */
  assetId: z.string().uuid(),
  version: z.number().int().min(1).optional(),
  agentId: AgentId,
  instruction: z.string().trim().max(5_000).default(''),
});
export type CreateRunRequest = z.infer<typeof CreateRunRequest>;

export const CreateRunResponse = z.object({ deduplicated: z.boolean(), run: RunView });
export type CreateRunResponse = z.infer<typeof CreateRunResponse>;

export const SubmitInputRequest = z.object({
  stepName: z.string().min(1).max(100),
  text: z.string().trim().min(1).max(20_000),
});
export type SubmitInputRequest = z.infer<typeof SubmitInputRequest>;

export const SubmitApprovalRequest = z.object({
  stepName: z.string().min(1).max(100),
  /** The hash of what the person saw. A decision for different content is refused. */
  proposalHash: z.string().min(1).max(200),
  decision: z.enum(['approved', 'rejected']),
});
export type SubmitApprovalRequest = z.infer<typeof SubmitApprovalRequest>;

export const SubmitResponse = z.object({
  /** False when this step already had an answer: the first one stands. */
  accepted: z.boolean(),
  run: RunView,
});
export type SubmitResponse = z.infer<typeof SubmitResponse>;
