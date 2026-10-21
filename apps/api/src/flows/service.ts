import type { AgentId, CreateFlowRequest, FlowView, FlowStepView } from '@littleboss/shared';
import { HttpError } from '../discussion/errors.js';
import type { ModelGateway } from '../discussion/gateway.js';
import type { Pricing } from '../discussion/pricing.js';
import { ProviderError } from '../discussion/providers/index.js';
import type { Roster } from '../discussion/roster.js';
import { draftPrompt, parseDraftOutput } from './draft.js';
import type { FlowRepository, FlowRow } from './repository.js';
import { isPast, nextSlots, validLocalDateTime } from './schedule.js';
import { TEMPLATES, type TemplateDef } from './templates.js';

export interface FlowServiceConfig {
  timeZone: string;
  /** Usual time of day an episode goes out, HH:mm. */
  defaultTime: string;
  dailyBudgetMicro: number;
  agent?: AgentId;
  maxInputTokens: number;
  callTries: number;
  retryDelayMs: number;
  /** A call that has not finished after this long is treated as dead. */
  staleCallMs: number;
}

export const DEFAULT_FLOW_CONFIG: FlowServiceConfig = {
  timeZone: 'Asia/Taipei',
  defaultTime: '18:00',
  dailyBudgetMicro: 1_000_000, // US$1 per 24 hours
  maxInputTokens: 20_000,
  callTries: 2,
  retryDelayMs: 1_500,
  staleCallMs: 6 * 60_000,
};

export interface FlowDeps {
  repo: FlowRepository;
  roster: Roster;
  gateway: ModelGateway;
  pricing: Pricing;
  config?: Partial<FlowServiceConfig>;
  clock?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

const FAILURES: Record<string, string> = {
  truncated: 'AI 的回覆在中途被截斷了，請再試一次。',
  refused: 'AI 拒絕處理這段內容。',
  empty: 'AI 回了空白的內容，請再試一次。',
  bad_format: 'AI 的回覆我看不懂（格式不對），請再試一次。',
  provider_unavailable: '連不上 AI（已自動重試過），請稍後再試。',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class FlowService {
  private readonly cfg: FlowServiceConfig;
  private readonly repo: FlowRepository;
  private readonly now: () => Date;

  constructor(private readonly d: FlowDeps) {
    this.cfg = { ...DEFAULT_FLOW_CONFIG, ...d.config };
    this.repo = d.repo;
    this.now = d.clock ?? (() => new Date());
  }

  // ---- reading --------------------------------------------------------------------------------

  private template(row: FlowRow): TemplateDef {
    const t = TEMPLATES[row.template as keyof typeof TEMPLATES];
    if (!t) throw new HttpError(500, 'unknown_template', `Unknown template ${row.template}.`);
    return t;
  }

  private view(row: FlowRow): FlowView {
    const t = this.template(row);
    const done: Record<string, boolean> = {
      notes: row.notes.trim().length > 0,
      draft: row.chosen !== null,
      schedule: row.publishAt !== null,
    };
    const steps: FlowStepView[] = t.steps.map((s) => ({
      key: s.key,
      kind: s.kind,
      title: s.title,
      help: s.help,
      status: (s.kind === 'manual' || s.kind === 'handoff' ? row.manualDone[s.key] : done[s.key])
        ? 'done'
        : 'todo',
      link: s.link ?? null,
    }));
    const warnings: string[] = [];
    if (row.publishAt && isPast(row.publishAt, this.now(), this.cfg.timeZone)) {
      warnings.push('這個發佈時間已經過了。');
    }
    return {
      id: row.id,
      template: t.id,
      title: row.title,
      state: steps.every((s) => s.status === 'done') ? 'done' : 'active',
      notes: row.notes,
      style: row.style,
      options: row.options,
      chosen: row.chosen,
      publishAt: row.publishAt,
      timeZone: this.cfg.timeZone,
      slots: nextSlots(this.now(), this.cfg.timeZone, t.publishDays, 4),
      defaultTime: this.cfg.defaultTime,
      steps,
      warnings,
      aiCostMicro: row.aiCostMicro,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async mustGet(id: string): Promise<FlowRow> {
    const row = await this.repo.get(id);
    if (!row) throw new HttpError(404, 'not_found', '找不到這個流程。');
    return row;
  }

  async list(): Promise<FlowView[]> {
    const rows = await this.repo.list(50);
    const views = rows.map((r) => this.view(r));
    // Unfinished first, each group most recently touched first.
    return [
      ...views.filter((v) => v.state === 'active'),
      ...views.filter((v) => v.state === 'done'),
    ];
  }

  async get(id: string): Promise<FlowView> {
    return this.view(await this.mustGet(id));
  }

  // ---- changing -------------------------------------------------------------------------------

  async create(req: CreateFlowRequest): Promise<{ deduplicated: boolean; flow: FlowView }> {
    const t = TEMPLATES[req.template];
    const { flow, created } = await this.repo.create({
      template: t.id,
      title: req.title ?? t.defaultTitle,
      clientRequestId: req.clientRequestId,
    });
    return { deduplicated: !created, flow: this.view(flow) };
  }

  async saveInputs(
    id: string,
    v: { notes?: string; style?: string; title?: string },
  ): Promise<FlowView> {
    const row = await this.repo.saveInputs(id, v);
    if (!row) throw new HttpError(404, 'not_found', '找不到這個流程。');
    return this.view(row);
  }

  async choose(id: string, chosen: { title: string; description: string }): Promise<FlowView> {
    const row = await this.repo.choose(id, chosen);
    if (!row) throw new HttpError(404, 'not_found', '找不到這個流程。');
    return this.view(row);
  }

  async setSchedule(id: string, publishAt: string | null): Promise<FlowView> {
    if (publishAt !== null && !validLocalDateTime(publishAt)) {
      throw new HttpError(400, 'invalid_time', '這不是有效的日期與時間。');
    }
    const row = await this.repo.setSchedule(id, publishAt);
    if (!row) throw new HttpError(404, 'not_found', '找不到這個流程。');
    return this.view(row);
  }

  async setStepDone(id: string, key: string, done: boolean): Promise<FlowView> {
    const row = await this.mustGet(id);
    const step = this.template(row).steps.find((s) => s.key === key);
    if (!step || (step.kind !== 'manual' && step.kind !== 'handoff')) {
      throw new HttpError(400, 'not_a_manual_step', '這一步不能手動勾選。');
    }
    const next = await this.repo.setManualDone(id, key, done);
    return this.view(next!);
  }

  // ---- the AI step ----------------------------------------------------------------------------

  private pickAgent() {
    const order: AgentId[] = this.cfg.agent ? [this.cfg.agent] : ['claude', 'gpt', 'gemini'];
    for (const id of order) {
      const a = this.d.roster.get(id);
      if (a.hired) return a;
    }
    throw new HttpError(400, 'agent_not_hired', '目前沒有可用的 AI，請先設定 API 金鑰。');
  }

  /**
   * Asks the AI for three titles and descriptions from the notes. Runs inside the request (the
   * API allows long requests); the boss waits on the screen. Costs money, so it is capped.
   */
  async generate(id: string): Promise<FlowView> {
    const row = await this.mustGet(id);
    if (row.notes.trim().length === 0) {
      throw new HttpError(409, 'needs_notes', '先寫下這集的重點，AI 才有東西可以寫。');
    }
    const agent = this.pickAgent();
    const prompt = draftPrompt({
      agentName: agent.displayName,
      notes: row.notes,
      style: row.style,
    });
    const tokens = this.d.pricing.estimateInputTokens(prompt.system + prompt.user);
    if (tokens > this.cfg.maxInputTokens) {
      throw new HttpError(413, 'context_too_large', '重點太長了，請精簡一點。', {
        inputTokens: tokens,
        limit: this.cfg.maxInputTokens,
      });
    }
    const estimate = this.d.gateway.estimateCostMicro(agent.id, prompt.system + prompt.user);
    const recent = await this.repo.recentSpendMicro();
    if (recent + estimate > this.cfg.dailyBudgetMicro) {
      throw new HttpError(402, 'over_budget', '這會超過 24 小時內的預算。', {
        totalMicro: estimate,
        spentMicro: recent,
        budgetLimitMicro: this.cfg.dailyBudgetMicro,
      });
    }
    if (!(await this.repo.claimGenerating(id, this.cfg.staleCallMs))) {
      throw new HttpError(409, 'busy', 'AI 正在寫，請稍等。');
    }
    try {
      return await this.callAi(row.id, agent, prompt);
    } finally {
      await this.repo.releaseGenerating(id).catch(() => undefined);
    }
  }

  private async callAi(
    flowId: string,
    agent: { id: AgentId; model: string },
    prompt: { system: string; user: string },
  ): Promise<FlowView> {
    const record = (c: {
      costMicro: number;
      usage?: unknown;
      rawOutput?: string | null;
      outcome: 'ok' | 'bad_format' | 'failed';
    }) =>
      this.repo.recordCall({
        flowId,
        agentId: agent.id,
        model: agent.model,
        costMicro: c.costMicro,
        usage: c.usage ?? null,
        rawOutput: c.rawOutput ?? null,
        outcome: c.outcome,
      });

    let last = 'Could not reach the AI.';
    for (let i = 1; i <= this.cfg.callTries; i += 1) {
      try {
        const r = await this.d.gateway.complete(agent.id, prompt);
        if (r.status === 'failed') {
          await record({ costMicro: 0, outcome: 'failed' });
          throw new HttpError(502, r.code, FAILURES[r.code] ?? r.reason);
        }
        const cost = r.costMicro ?? 0;
        if (r.status === 'bad') {
          await record({ costMicro: cost, usage: r.usage, rawOutput: r.text, outcome: 'failed' });
          throw new HttpError(502, r.reason, FAILURES[r.reason] ?? 'AI 的回覆不能用。');
        }
        const parsed = parseDraftOutput(r.text);
        if (!parsed.ok) {
          await record({
            costMicro: cost,
            usage: r.usage,
            rawOutput: r.text,
            outcome: 'bad_format',
          });
          throw new HttpError(502, 'bad_format', FAILURES.bad_format!);
        }
        await record({ costMicro: cost, usage: r.usage, rawOutput: r.text, outcome: 'ok' });
        const saved = await this.repo.saveOptions(flowId, parsed.options);
        return this.view(saved!);
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err.message;
        if (i < this.cfg.callTries) await sleep(this.cfg.retryDelayMs);
      }
    }
    await record({ costMicro: 0, outcome: 'failed' });
    throw new HttpError(502, 'provider_unavailable', `${FAILURES.provider_unavailable} ${last}`);
  }
}
