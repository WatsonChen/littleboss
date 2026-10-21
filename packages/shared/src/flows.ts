import { z } from 'zod';

/** Flow contracts (a routine walked through step by step), shared by apps/web and apps/api. */

export const FlowTemplateId = z.enum(['podcast-episode']);
export type FlowTemplateId = z.infer<typeof FlowTemplateId>;

/**
 * input     the boss writes something (notes)
 * ai        the AI drafts something and the boss picks
 * schedule  the boss picks a date and time
 * manual    the boss does it in another app and ticks it
 * handoff   everything is ready to paste into another app; the boss ticks it when done
 */
export const FlowStepKind = z.enum(['input', 'ai', 'schedule', 'manual', 'handoff']);
export type FlowStepKind = z.infer<typeof FlowStepKind>;

export const FlowStepView = z.object({
  key: z.string(),
  kind: FlowStepKind,
  title: z.string(),
  help: z.string(),
  status: z.enum(['todo', 'done']),
  link: z.object({ label: z.string(), url: z.string() }).nullable(),
});
export type FlowStepView = z.infer<typeof FlowStepView>;

export const FlowDraftOption = z.object({ title: z.string(), description: z.string() });
export type FlowDraftOption = z.infer<typeof FlowDraftOption>;

export const FlowSlot = z.object({
  /** YYYY-MM-DD */
  date: z.string(),
  /** e.g. 週四 10/22 */
  label: z.string(),
});
export type FlowSlot = z.infer<typeof FlowSlot>;

export const FlowView = z.object({
  id: z.string(),
  template: FlowTemplateId,
  title: z.string(),
  state: z.enum(['active', 'done']),
  notes: z.string(),
  style: z.string(),
  /** What the AI proposed last time. */
  options: z.array(FlowDraftOption),
  /** What the boss picked or edited: the text to paste. */
  chosen: FlowDraftOption.nullable(),
  /** Local date and time, YYYY-MM-DDTHH:mm, in `timeZone`. */
  publishAt: z.string().nullable(),
  timeZone: z.string(),
  /** The next publishing days, with the usual time of day. */
  slots: z.array(FlowSlot),
  defaultTime: z.string(),
  steps: z.array(FlowStepView),
  warnings: z.array(z.string()),
  aiCostMicro: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FlowView = z.infer<typeof FlowView>;

export const CreateFlowRequest = z.object({
  clientRequestId: z.string().min(8).max(100),
  template: FlowTemplateId,
  title: z.string().trim().min(1).max(120).optional(),
});
export type CreateFlowRequest = z.infer<typeof CreateFlowRequest>;

export const CreateFlowResponse = z.object({ deduplicated: z.boolean(), flow: FlowView });
export type CreateFlowResponse = z.infer<typeof CreateFlowResponse>;

export const SaveFlowInputsRequest = z.object({
  notes: z.string().max(8000).optional(),
  style: z.string().max(4000).optional(),
  title: z.string().trim().min(1).max(120).optional(),
});
export type SaveFlowInputsRequest = z.infer<typeof SaveFlowInputsRequest>;

export const ChooseFlowDraftRequest = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000),
});
export type ChooseFlowDraftRequest = z.infer<typeof ChooseFlowDraftRequest>;

export const SetFlowScheduleRequest = z.object({
  publishAt: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
    .nullable(),
});
export type SetFlowScheduleRequest = z.infer<typeof SetFlowScheduleRequest>;

export const SetFlowStepDoneRequest = z.object({ done: z.boolean() });
export type SetFlowStepDoneRequest = z.infer<typeof SetFlowStepDoneRequest>;

export const FlowResponse = z.object({ flow: FlowView });
export type FlowResponse = z.infer<typeof FlowResponse>;
