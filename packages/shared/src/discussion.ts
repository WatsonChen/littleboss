import { z } from 'zod';
import { CallStatus } from './call-status.js';

/** Discussion room contracts (M1), shared by apps/web and apps/api. */

export const AgentId = z.enum(['claude', 'gpt', 'gemini']);
export type AgentId = z.infer<typeof AgentId>;

export const MessageRole = z.enum(['user', 'context', 'agent']);
export type MessageRole = z.infer<typeof MessageRole>;

/** Call states plus `sent` for messages that are not AI calls (the person's own notes). */
export const MessageStatus = z.union([CallStatus, z.literal('sent')]);
export type MessageStatus = z.infer<typeof MessageStatus>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string() }).passthrough(),
});
export type ApiError = z.infer<typeof ApiError>;

export const AgentInfo = z.object({
  id: AgentId,
  displayName: z.string(),
  provider: z.string(),
  model: z.string(),
  /** False when no API key is configured: shown as "not hired yet". */
  hired: z.boolean(),
});
export type AgentInfo = z.infer<typeof AgentInfo>;

export const MessageView = z.object({
  id: z.string(),
  threadId: z.string(),
  seq: z.number().int(),
  role: MessageRole,
  agentId: AgentId.nullable(),
  replyToId: z.string().nullable(),
  /** The person's message that started this call. */
  triggerId: z.string().nullable(),
  content: z.string(),
  status: MessageStatus,
  error: z.object({ code: z.string(), message: z.string() }).passthrough().nullable(),
  /** Ids of the messages this call was shown. Empty for non-call messages. */
  seenMessageIds: z.array(z.string()),
  estimatedCostMicro: z.number().nullable(),
  costMicro: z.number().nullable(),
  /** True until the provider reports real usage; costs here are never presented as exact. */
  costIsEstimate: z.boolean(),
  attemptCount: z.number().int(),
  editedByUser: z.boolean(),
  createdAt: z.string(),
  queuedAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type MessageView = z.infer<typeof MessageView>;

export const ThreadSummary = z.object({
  id: z.string(),
  title: z.string(),
  budgetLimitMicro: z.number(),
  spentMicro: z.number(),
  updatedAt: z.string(),
  messageCount: z.number().int(),
});
export type ThreadSummary = z.infer<typeof ThreadSummary>;

export const ThreadDetail = z.object({
  thread: ThreadSummary,
  messages: z.array(MessageView),
  agents: z.array(AgentInfo),
});
export type ThreadDetail = z.infer<typeof ThreadDetail>;

export const CreateThreadRequest = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  budgetLimitMicro: z.number().int().min(0).max(1_000_000_000).optional(),
});
export type CreateThreadRequest = z.infer<typeof CreateThreadRequest>;

export const RenameThreadRequest = z.object({ title: z.string().trim().min(1).max(120) });
export type RenameThreadRequest = z.infer<typeof RenameThreadRequest>;

const content = z.string().trim().min(1).max(60_000);

export const EstimateRequest = z.object({
  content,
  /** Explicit targets; when absent they are read from @mentions in `content`. */
  mentions: z.array(AgentId).max(3).optional(),
  /** Same as in SendMessageRequest: the review target changes what is sent, so it changes the estimate. */
  replyToId: z.string().uuid().optional(),
});
export type EstimateRequest = z.infer<typeof EstimateRequest>;

export const CallEstimate = z.object({
  agentId: AgentId,
  inputTokens: z.number().int(),
  maxOutputTokens: z.number().int(),
  estimatedCostMicro: z.number().int(),
});
export const EstimateResponse = z.object({
  calls: z.array(CallEstimate),
  totalMicro: z.number().int(),
  spentMicro: z.number().int(),
  budgetLimitMicro: z.number().int(),
  withinBudget: z.boolean(),
  /** Always true in M1: provider prices are configured by hand and usage is only known afterwards. */
  isEstimate: z.literal(true),
});
export type EstimateResponse = z.infer<typeof EstimateResponse>;

export const SendMessageRequest = z.object({
  /** A fresh id per send. Sending the same id again returns the first result and calls nobody. */
  clientRequestId: z.string().min(8).max(100),
  kind: z.enum(['user', 'context']).default('user'),
  content,
  mentions: z.array(AgentId).max(3).optional(),
  /** The message a reviewer is asked to check, or the one a revision answers. */
  replyToId: z.string().uuid().optional(),
  /** The total the person accepted when they saw the estimate. A higher estimate is refused. */
  acceptedMaxCostMicro: z.number().int().min(0).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const SendMessageResponse = z.object({
  /** True when this request id was already used: nothing new was created or dispatched. */
  deduplicated: z.boolean(),
  messages: z.array(MessageView),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponse>;

export const EditMessageRequest = z.object({ content });
export type EditMessageRequest = z.infer<typeof EditMessageRequest>;

export const SaveConclusionRequest = z.object({
  title: z.string().trim().min(1).max(120),
  /** The saved text: a selected message as is, or the person's merged and edited version. */
  content,
  sourceMessageIds: z.array(z.string().uuid()).min(1).max(50),
  /** Adds a new version to this asset instead of creating a new one. */
  assetId: z.string().uuid().optional(),
});
export type SaveConclusionRequest = z.infer<typeof SaveConclusionRequest>;

export const AssetVersionView = z.object({
  assetId: z.string(),
  title: z.string(),
  version: z.number().int(),
  content: z.string(),
  sourceMessageIds: z.array(z.string()),
  createdAt: z.string(),
});
export type AssetVersionView = z.infer<typeof AssetVersionView>;

/** The saved record of one call, for checking what was sent and what it cost. */
export const CallRecord = z.object({
  messageId: z.string(),
  agentConfig: z.unknown().nullable(),
  prompt: z.unknown().nullable(),
  injectedMemory: z.array(z.unknown()),
  usage: z.unknown().nullable(),
  attempts: z.array(z.unknown()),
  seenMessageIds: z.array(z.string()),
});
export type CallRecord = z.infer<typeof CallRecord>;
