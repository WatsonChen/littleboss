import {
  type AgentId,
  type AssetVersionView,
  type CallRecord,
  type CreateThreadRequest,
  type EditMessageRequest,
  type EstimateRequest,
  type EstimateResponse,
  type MessageView,
  type SaveConclusionRequest,
  type SendMessageRequest,
  type SendMessageResponse,
  type ThreadDetail,
  type ThreadSummary,
} from '@littleboss/shared';
import type { Dispatcher } from './dispatcher.js';
import { HttpError } from './errors.js';
import { parseMentions } from './mentions.js';
import type { Pricing } from './pricing.js';
import { buildPrompt, type Prompt, type PromptMessage } from './prompt.js';
import { ProviderError, type ProviderSet } from './providers/index.js';
import { toView, type DiscussionRepository, type Finish, type MessageRow } from './repository.js';
import type { Roster } from './roster.js';

export interface ServiceConfig {
  callTimeoutMs: number;
  /** A running call silent for this long is treated as lost and may be taken over or retried. */
  staleRunningMs: number;
  /** A queued call that nobody picked up for this long may be retried. */
  staleQueuedMs: number;
  maxInputTokens: number;
  defaultBudgetMicro: number;
}

export const DEFAULT_CONFIG: ServiceConfig = {
  callTimeoutMs: 120_000,
  staleRunningMs: 5 * 60_000,
  staleQueuedMs: 60_000,
  maxInputTokens: 100_000,
  defaultBudgetMicro: 2_000_000, // US$2
};

export interface Deps {
  repo: DiscussionRepository;
  roster: Roster;
  providers: ProviderSet;
  dispatcher: Dispatcher;
  pricing: Pricing;
  config?: Partial<ServiceConfig>;
  log?: (msg: string, err?: unknown) => void;
}

interface PlannedCall {
  agentId: AgentId;
  inputTokens: number;
  maxOutputTokens: number;
  estimatedCostMicro: number;
  prompt: Prompt;
}

const RUN_ERRORS = {
  truncated: 'The reply was cut off at the length limit.',
  refused: 'The model declined to answer.',
  empty: 'The model returned an empty reply.',
} as const;

export class DiscussionService {
  private readonly cfg: ServiceConfig;
  private readonly repo: DiscussionRepository;

  constructor(private readonly d: Deps) {
    this.cfg = { ...DEFAULT_CONFIG, ...d.config };
    this.repo = d.repo;
    d.dispatcher.bind?.((id) => this.runCall(id));
  }

  /** For health checks only. */
  db() {
    return this.repo.health();
  }

  agents() {
    return this.d.roster.list();
  }

  // ---- threads -------------------------------------------------------------------------------

  createThread(req: CreateThreadRequest): Promise<ThreadSummary> {
    return this.repo.createThread(
      req.title ?? '新的討論',
      req.budgetLimitMicro ?? this.cfg.defaultBudgetMicro,
    );
  }

  async renameThread(id: string, title: string): Promise<ThreadSummary> {
    if (!(await this.repo.renameThread(id, title.trim()))) {
      throw new HttpError(404, 'thread_not_found', 'No such discussion.');
    }
    return (await this.repo.getThread(id))!;
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.repo.listThreads();
  }

  async getThread(id: string): Promise<ThreadDetail> {
    // Messages first: if a call finishes in between, the summary is the newer of the two and the
    // screen keeps polling until they agree. The other order could show a finished call next to a
    // total that still counts its estimate, with nothing left to trigger a refresh.
    const messages = await this.repo.listMessages(id);
    const thread = await this.repo.getThread(id);
    if (!thread) throw new HttpError(404, 'thread_not_found', 'No such discussion.');
    return { thread, messages: messages.map(toView), agents: this.agents() };
  }

  // ---- planning (shared by estimate and send) -------------------------------------------------

  private visibleTo(all: MessageRow[]): MessageRow[] {
    return all.filter((m) => m.role !== 'agent' || m.status === 'succeeded');
  }

  private promptMessage(m: MessageRow): PromptMessage {
    return {
      role: m.role,
      agentName: m.agentId ? this.d.roster.get(m.agentId).displayName : undefined,
      content: m.content,
    };
  }

  private makePrompt(
    agentId: AgentId,
    visible: MessageRow[],
    task: string,
    target: MessageRow | undefined,
  ): Prompt {
    return buildPrompt({
      agentName: this.d.roster.get(agentId).displayName,
      visible: visible.filter((m) => m.id !== target?.id).map((m) => this.promptMessage(m)),
      task,
      reviewTarget: target ? this.promptMessage(target) : undefined,
    });
  }

  private plan(
    visible: MessageRow[],
    content: string,
    targets: AgentId[],
    replyToId: string | undefined,
  ): PlannedCall[] {
    const unhired = targets.filter((t) => !this.d.roster.get(t).hired);
    if (unhired.length > 0) {
      throw new HttpError(400, 'agent_not_hired', `Not hired yet: ${unhired.join(', ')}.`, {
        agents: unhired,
      });
    }
    let target: MessageRow | undefined;
    if (replyToId) {
      target = visible.find((m) => m.id === replyToId);
      if (!target) {
        throw new HttpError(400, 'bad_reply_target', 'That message cannot be reviewed here.');
      }
    }
    return targets.map((agentId) => {
      const prompt = this.makePrompt(agentId, visible, content, target);
      const inputTokens = this.d.pricing.estimateInputTokens(prompt.system + prompt.user);
      if (inputTokens > this.cfg.maxInputTokens) {
        throw new HttpError(
          413,
          'context_too_large',
          'The discussion plus the pasted material is too long to send. Shorten the pasted text or start a new discussion.',
          { inputTokens, limit: this.cfg.maxInputTokens },
        );
      }
      const maxOutputTokens = this.d.pricing.maxOutputTokens;
      return {
        agentId,
        inputTokens,
        maxOutputTokens,
        estimatedCostMicro: this.d.pricing.estimateCostMicro(agentId, inputTokens, maxOutputTokens),
        prompt,
      };
    });
  }

  private targetsOf(req: { content: string; mentions?: AgentId[]; kind?: 'user' | 'context' }) {
    if (req.kind === 'context') return [];
    return req.mentions ?? parseMentions(req.content);
  }

  async estimate(threadId: string, req: EstimateRequest): Promise<EstimateResponse> {
    const thread = await this.repo.getThread(threadId);
    if (!thread) throw new HttpError(404, 'thread_not_found', 'No such discussion.');
    const visible = this.visibleTo(await this.repo.listMessages(threadId));
    const calls = this.plan(visible, req.content, this.targetsOf(req), req.replyToId);
    const totalMicro = calls.reduce((s, c) => s + c.estimatedCostMicro, 0);
    return {
      calls: calls.map((c) => ({
        agentId: c.agentId,
        inputTokens: c.inputTokens,
        maxOutputTokens: c.maxOutputTokens,
        estimatedCostMicro: c.estimatedCostMicro,
      })),
      totalMicro,
      spentMicro: thread.spentMicro,
      budgetLimitMicro: thread.budgetLimitMicro,
      withinBudget: thread.spentMicro + totalMicro <= thread.budgetLimitMicro,
      isEstimate: true,
    };
  }

  // ---- sending -------------------------------------------------------------------------------

  async send(threadId: string, req: SendMessageRequest): Promise<SendMessageResponse> {
    const targets = this.targetsOf(req);
    const out = await this.repo.withThread(threadId, async (tx) => {
      const existing = await tx.findByRequestId(req.clientRequestId);
      if (existing.length > 0) return { deduplicated: true, rows: existing };

      const visible = this.visibleTo(await tx.messages());
      const calls = this.plan(visible, req.content, targets, req.replyToId);
      const totalMicro = calls.reduce((s, c) => s + c.estimatedCostMicro, 0);
      if (req.acceptedMaxCostMicro !== undefined && totalMicro > req.acceptedMaxCostMicro) {
        throw new HttpError(
          409,
          'estimate_changed',
          'The estimated cost is now higher than the amount you confirmed.',
          { totalMicro, acceptedMaxCostMicro: req.acceptedMaxCostMicro },
        );
      }
      const spentMicro = await tx.spentMicro();
      if (spentMicro + totalMicro > tx.budgetLimitMicro) {
        throw new HttpError(402, 'over_budget', 'This would go over the discussion budget.', {
          totalMicro,
          spentMicro,
          budgetLimitMicro: tx.budgetLimitMicro,
        });
      }

      const [user] = await tx.insert([
        {
          role: req.kind,
          content: req.content,
          status: 'sent',
          clientRequestId: req.clientRequestId,
          replyToId: req.replyToId,
        },
      ]);
      // Every call from this send is shown the same snapshot, whatever order they finish in.
      const seen = [...visible.map((m) => m.id), user!.id];
      const agentRows =
        calls.length === 0
          ? []
          : await tx.insert(
              calls.map((c) => {
                const agent = this.d.roster.get(c.agentId);
                return {
                  role: 'agent' as const,
                  agentId: c.agentId,
                  replyToId: req.replyToId,
                  triggerId: user!.id,
                  content: '',
                  status: 'queued' as const,
                  seenMessageIds: seen,
                  agentConfig: {
                    provider: agent.provider,
                    model: agent.model,
                    promptVersion: c.prompt.version,
                    maxOutputTokens: c.maxOutputTokens,
                  },
                  estimatedCostMicro: c.estimatedCostMicro,
                };
              }),
            );
      return { deduplicated: false, rows: [user!, ...agentRows] };
    });

    if (!out.deduplicated) {
      for (const row of out.rows.filter((r) => r.role === 'agent')) {
        await this.dispatch(row);
      }
    }
    return { deduplicated: out.deduplicated, messages: out.rows.map(toView) };
  }

  /** A failed hand-off leaves the call queued; the person can retry it from the screen. */
  private async dispatch(row: MessageRow): Promise<void> {
    try {
      await this.d.dispatcher.dispatch(row.id, row.attemptCount + 1);
    } catch (err) {
      this.d.log?.(`dispatch of ${row.id} failed`, err);
    }
  }

  // ---- running one call ----------------------------------------------------------------------

  /** Runs a queued call to its end. Safe to call twice: only one caller gets to run it. */
  async runCall(messageId: string): Promise<{ ran: boolean }> {
    const claimed = await this.repo.claim(messageId, this.cfg.staleRunningMs);
    if (!claimed) return { ran: false };
    const attempt = claimed.attemptCount;
    const finish = (f: Finish) => this.repo.finish(messageId, attempt, f);
    try {
      const agentId = claimed.agentId!;
      const agent = this.d.roster.get(agentId);
      if (!agent.hired || !agent.apiKey) {
        await finish(fail('agent_not_hired', 'This AI is no longer set up.', 0));
        return { ran: true };
      }
      const seen = await this.repo.getMessagesByIds(claimed.seenMessageIds);
      const trigger = seen.find((m) => m.id === claimed.triggerId);
      if (!trigger) {
        await finish(fail('missing_context', 'The message that started this call is gone.', 0));
        return { ran: true };
      }
      const visible = seen.filter((m) => m.id !== trigger.id);
      const target = claimed.replyToId
        ? visible.find((m) => m.id === claimed.replyToId)
        : undefined;
      const prompt = this.makePrompt(agentId, visible, trigger.content, target);
      await this.repo.savePrompt(messageId, attempt, prompt);

      const maxOutputTokens = this.d.pricing.maxOutputTokens;
      try {
        const r = await this.d.providers[agent.providerId].call({
          model: agent.model,
          apiKey: agent.apiKey,
          system: prompt.system,
          user: prompt.user,
          maxOutputTokens,
          timeoutMs: this.cfg.callTimeoutMs,
        });
        const costMicro = r.usage ? this.d.pricing.actualCostMicro(agentId, r.usage) : null;
        const common = { usage: r.usage, costMicro, costIsEstimate: r.usage === null };
        if (r.finish === 'complete') {
          await finish({ status: 'succeeded', content: r.text, error: null, ...common });
        } else {
          await finish({
            status: 'bad_format',
            content: r.text,
            error: { code: r.finish, message: RUN_ERRORS[r.finish] },
            ...common,
          });
        }
      } catch (err) {
        if (err instanceof ProviderError) {
          if (err.kind === 'timeout') {
            // The provider may still have done the work, so count the estimate.
            await finish({
              status: 'timed_out',
              content: '',
              error: { code: 'timeout', message: err.message },
              usage: null,
              costMicro: claimed.estimatedCostMicro,
              costIsEstimate: true,
            });
          } else {
            const code =
              err.kind === 'network'
                ? 'network_error'
                : err.status === 429
                  ? 'rate_limited'
                  : err.status === 401 || err.status === 403
                    ? 'auth_failed'
                    : 'provider_error';
            await finish(fail(code, err.message, 0));
          }
        } else {
          throw err;
        }
      }
    } catch (err) {
      this.d.log?.(`call ${messageId} crashed`, err);
      await finish(
        fail('internal_error', 'Something went wrong while running this call.', 0),
      ).catch(() => undefined);
    }
    return { ran: true };
  }

  // ---- fixing things up ----------------------------------------------------------------------

  private async agentMessage(id: string): Promise<MessageRow> {
    const row = await this.repo.getMessage(id);
    if (!row) throw new HttpError(404, 'message_not_found', 'No such message.');
    if (row.role !== 'agent')
      throw new HttpError(400, 'not_a_call', 'This message is not an AI reply.');
    return row;
  }

  async retry(messageId: string): Promise<MessageView> {
    const row = await this.agentMessage(messageId);
    const agentId = row.agentId!;
    if (!this.d.roster.get(agentId).hired) {
      throw new HttpError(400, 'agent_not_hired', `Not hired yet: ${agentId}.`, {
        agents: [agentId],
      });
    }
    const seen = await this.repo.getMessagesByIds(row.seenMessageIds);
    const trigger = seen.find((m) => m.id === row.triggerId);
    if (!trigger)
      throw new HttpError(409, 'missing_context', 'The message that started this call is gone.');
    const visible = seen.filter((m) => m.id !== trigger.id);
    const target = row.replyToId ? visible.find((m) => m.id === row.replyToId) : undefined;
    const prompt = this.makePrompt(agentId, visible, trigger.content, target);
    const inputTokens = this.d.pricing.estimateInputTokens(prompt.system + prompt.user);
    const estimate = this.d.pricing.estimateCostMicro(
      agentId,
      inputTokens,
      this.d.pricing.maxOutputTokens,
    );

    const requeued = await this.repo.withThread(row.threadId, async (tx) => {
      const r = await tx.requeue(
        messageId,
        estimate,
        this.cfg.staleQueuedMs,
        this.cfg.staleRunningMs,
      );
      if (!r) {
        throw new HttpError(
          409,
          'not_retryable',
          'This call is still in progress or already finished. Wait a little, or reload.',
        );
      }
      const spentMicro = await tx.spentMicro();
      if (spentMicro > tx.budgetLimitMicro) {
        throw new HttpError(402, 'over_budget', 'This would go over the discussion budget.', {
          totalMicro: estimate,
          spentMicro: spentMicro - estimate,
          budgetLimitMicro: tx.budgetLimitMicro,
        });
      }
      return r;
    });
    await this.dispatch(requeued);
    return toView(requeued);
  }

  async editBadFormat(messageId: string, req: EditMessageRequest): Promise<MessageView> {
    const row = await this.agentMessage(messageId);
    const edited = await this.repo.withThread(row.threadId, (tx) =>
      tx.editBadFormat(messageId, req.content),
    );
    if (!edited) {
      throw new HttpError(
        409,
        'not_editable',
        'Only a reply that came back unusable can be edited.',
      );
    }
    return toView(edited);
  }

  async record(messageId: string): Promise<CallRecord> {
    const row = await this.agentMessage(messageId);
    return {
      messageId: row.id,
      agentConfig: row.agentConfig,
      prompt: row.prompt,
      injectedMemory: row.injectedMemory,
      usage: row.usage,
      attempts: row.attempts,
      seenMessageIds: row.seenMessageIds,
    };
  }

  // ---- conclusions ---------------------------------------------------------------------------

  saveConclusion(threadId: string, req: SaveConclusionRequest): Promise<AssetVersionView> {
    return this.repo.withThread(threadId, (tx) => tx.saveConclusion(req));
  }

  async listConclusions(threadId: string): Promise<AssetVersionView[]> {
    if (!(await this.repo.getThread(threadId))) {
      throw new HttpError(404, 'thread_not_found', 'No such discussion.');
    }
    return this.repo.listAssets(threadId);
  }
}

function fail(code: string, message: string, costMicro: number): Finish {
  return {
    status: 'failed',
    content: '',
    error: { code, message },
    usage: null,
    costMicro,
    costIsEstimate: false,
  };
}
