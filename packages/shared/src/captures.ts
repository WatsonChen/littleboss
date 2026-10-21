import { z } from 'zod';
import { AgentId } from './discussion.js';

/** Quick capture contracts (M2, second track), shared by apps/web and apps/api. */

export const CaptureState = z.enum(['queued', 'parsing', 'ready', 'failed']);
export type CaptureState = z.infer<typeof CaptureState>;

export const CaptureItemKind = z.enum(['shopping', 'event']);
export type CaptureItemKind = z.infer<typeof CaptureItemKind>;

/**
 * proposed     the AI suggested it; waiting for the person
 * needs_info   something essential is missing (an event without a time); cannot be approved yet
 * rejected     the person said no
 * writing      approved, being written right now
 * saved        written
 * failed       approved but the write did not happen (see `error`); can be tried again
 */
export const CaptureItemStatus = z.enum([
  'proposed',
  'needs_info',
  'rejected',
  'writing',
  'saved',
  'failed',
]);
export type CaptureItemStatus = z.infer<typeof CaptureItemStatus>;

export const CaptureItemView = z.object({
  id: z.string(),
  kind: CaptureItemKind,
  status: CaptureItemStatus,
  /** `said` came from the person's own words; `suggested` is something the AI added. */
  origin: z.enum(['said', 'suggested']),
  title: z.string(),
  note: z.string(),
  /** Shopping only, e.g. "2 包". */
  quantity: z.string(),
  /** Events only. ISO date-time with offset, or a date (YYYY-MM-DD) when `allDay`. */
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  allDay: z.boolean(),
  timeZone: z.string(),
  /** What the AI had to guess. Shown as guesses, never as facts. */
  assumptions: z.array(z.string()),
  /** What the AI could not tell and wants to know. */
  question: z.string(),
  /** Problems the person should see before approving (e.g. the time is already past). */
  warnings: z.array(z.string()),
  /** Binds an approval to exactly what the person saw. */
  payloadHash: z.string(),
  /** Where it ended up, once saved. */
  result: z
    .object({
      destination: z.enum(['little-boss-shopping', 'google-calendar', 'demo-calendar']),
      /** True when nothing really reached the outside service (demo mode). */
      demo: z.boolean(),
      link: z.string().nullable(),
    })
    .nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  /** Written by this app on the person's behalf only after approval. */
  approvedAt: z.string().nullable(),
});
export type CaptureItemView = z.infer<typeof CaptureItemView>;

export const CaptureView = z.object({
  id: z.string(),
  text: z.string(),
  state: CaptureState,
  agentId: AgentId,
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
  items: z.array(CaptureItemView),
  /** Questions about the whole text, not about one item. */
  questions: z.array(z.string()),
  costMicro: z.number(),
  estimatedCostMicro: z.number(),
  attemptCount: z.number().int(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type CaptureView = z.infer<typeof CaptureView>;

export const CreateCaptureRequest = z.object({
  /** A fresh id per tap. Sending it again returns the first capture and starts nothing. */
  clientRequestId: z.string().min(8).max(100),
  text: z.string().trim().min(1).max(8_000),
});
export type CreateCaptureRequest = z.infer<typeof CreateCaptureRequest>;

export const CreateCaptureResponse = z.object({ deduplicated: z.boolean(), capture: CaptureView });
export type CreateCaptureResponse = z.infer<typeof CreateCaptureResponse>;

export const EditCaptureItemRequest = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  note: z.string().trim().max(1_000).optional(),
  quantity: z.string().trim().max(50).optional(),
  startsAt: z.string().max(40).nullable().optional(),
  endsAt: z.string().max(40).nullable().optional(),
  allDay: z.boolean().optional(),
});
export type EditCaptureItemRequest = z.infer<typeof EditCaptureItemRequest>;

export const ApproveCaptureItemRequest = z.object({
  /** The hash of what the person saw. If the item changed since, the approval is refused. */
  payloadHash: z.string().min(1).max(200),
});
export type ApproveCaptureItemRequest = z.infer<typeof ApproveCaptureItemRequest>;

export const CaptureItemResponse = z.object({
  /** False when this item had already been decided: the first decision stands. */
  accepted: z.boolean(),
  capture: CaptureView,
});
export type CaptureItemResponse = z.infer<typeof CaptureItemResponse>;

export const ShoppingItemView = z.object({
  id: z.string(),
  title: z.string(),
  note: z.string(),
  quantity: z.string(),
  done: z.boolean(),
  captureId: z.string().nullable(),
  createdAt: z.string(),
});
export type ShoppingItemView = z.infer<typeof ShoppingItemView>;

export const SetShoppingDoneRequest = z.object({ done: z.boolean() });
export type SetShoppingDoneRequest = z.infer<typeof SetShoppingDoneRequest>;
