import {
  type AgentId,
  type ApproveCaptureItemRequest,
  type CaptureItemResponse,
  type CaptureItemView,
  type CaptureView,
  type CreateCaptureRequest,
  type CreateCaptureResponse,
  type EditCaptureItemRequest,
  type ShoppingItemView,
} from '@littleboss/shared';
import { HttpError } from '../discussion/errors.js';
import type { ModelGateway } from '../discussion/gateway.js';
import type { Pricing } from '../discussion/pricing.js';
import { ProviderError } from '../discussion/providers/index.js';
import type { Roster } from '../discussion/roster.js';
import { eventIdFor, type CalendarClient } from './calendar.js';
import {
  CAPTURE_ROLE_VERSION,
  capturePrompt,
  normalizeTimes,
  parseCaptureOutput,
  payloadHash,
  warningsFor,
  type ItemPayload,
} from './parse.js';
import type {
  CaptureConfig,
  CaptureRepository,
  CaptureRow,
  ItemRow,
  ShoppingRow,
} from './repository.js';

/** Starts a capture somewhere that can run it. `key` makes a repeated request a no-op. */
export interface CaptureEngine {
  kick(captureId: string, key: string): Promise<void>;
  bind?(run: (captureId: string) => Promise<unknown>): void;
}

export interface CaptureServiceConfig {
  timeZone: string;
  /** Most the AI may cost over any 24 hours across all captures. */
  dailyBudgetMicro: number;
  maxAttempts: number;
  /** A parse that has been silent this long is treated as lost. */
  staleParsingMs: number;
  staleWritingMs: number;
  reconcileIdleMs: number;
  maxInputTokens: number;
  /** In-process tries for trouble that may pass (timeout, rate limit, 5xx). */
  callTries: number;
  retryDelayMs: number;
  /** Preferred AI for reading captures; the first one that is set up is used otherwise. */
  agent?: AgentId;
}

export const DEFAULT_CAPTURE_CONFIG: CaptureServiceConfig = {
  timeZone: 'Asia/Taipei',
  dailyBudgetMicro: 1_000_000, // US$1 per 24 hours
  maxAttempts: 3,
  staleParsingMs: 5 * 60_000,
  staleWritingMs: 2 * 60_000,
  reconcileIdleMs: 2 * 60_000,
  maxInputTokens: 20_000,
  callTries: 2,
  retryDelayMs: 1_500,
};

export interface CaptureDeps {
  repo: CaptureRepository;
  roster: Roster;
  gateway: ModelGateway;
  pricing: Pricing;
  calendar: CalendarClient;
  engine: CaptureEngine;
  config?: Partial<CaptureServiceConfig>;
  clock?: () => Date;
  log?: (msg: string, err?: unknown) => void;
}

const FAILURES: Record<string, string> = {
  truncated: 'AI 的回覆在中途被截斷了。',
  refused: 'AI 拒絕處理這段內容。',
  empty: 'AI 回了空白的內容。',
  bad_format: 'AI 的回覆我看不懂（格式不對）。',
  provider_unavailable: '連不上 AI（已自動重試過）。',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CaptureService {
  private readonly cfg: CaptureServiceConfig;
  private readonly repo: CaptureRepository;
  private readonly now: () => Date;

  constructor(private readonly d: CaptureDeps) {
    this.cfg = { ...DEFAULT_CAPTURE_CONFIG, ...d.config };
    this.repo = d.repo;
    this.now = d.clock ?? (() => new Date());
    d.engine.bind?.((id) => this.run(id));
  }

  // ---- create / retry -------------------------------------------------------------------------

  private pickAgent() {
    const order: AgentId[] = this.cfg.agent ? [this.cfg.agent] : ['claude', 'gpt', 'gemini'];
    for (const id of order) {
      const a = this.d.roster.get(id);
      if (a.hired) return a;
    }
    throw new HttpError(400, 'agent_not_hired', '目前沒有可用的 AI，請先設定 API 金鑰。');
  }

  private estimateFor(agentId: AgentId, agentName: string, text: string): number {
    const p = capturePrompt({ agentName, text, now: this.now(), timeZone: this.cfg.timeZone });
    const tokens = this.d.pricing.estimateInputTokens(p.system + p.user);
    if (tokens > this.cfg.maxInputTokens) {
      throw new HttpError(413, 'context_too_large', '這段文字太長了，請分成幾段。', {
        inputTokens: tokens,
        limit: this.cfg.maxInputTokens,
      });
    }
    return this.d.gateway.estimateCostMicro(agentId, p.system + p.user);
  }

  private overBudget(recent: number, estimate: number): never {
    throw new HttpError(402, 'over_budget', '這會超過 24 小時內的隨手捕捉預算。', {
      totalMicro: estimate,
      spentMicro: recent,
      budgetLimitMicro: this.cfg.dailyBudgetMicro,
    });
  }

  async create(req: CreateCaptureRequest): Promise<CreateCaptureResponse> {
    const agent = this.pickAgent();
    const estimate = this.estimateFor(agent.id, agent.displayName, req.text);
    const config: CaptureConfig = {
      roleVersion: CAPTURE_ROLE_VERSION,
      agentId: agent.id,
      agentName: agent.displayName,
      model: agent.model,
      timeZone: this.cfg.timeZone,
    };
    const { capture, created } = await this.repo.create(
      {
        text: req.text,
        clientRequestId: req.clientRequestId,
        config,
        estimatedCostMicro: estimate,
      },
      (recent) => {
        if (recent + estimate > this.cfg.dailyBudgetMicro) this.overBudget(recent, estimate);
      },
    );
    if (created) await this.kick(capture.id, `${capture.id}:start`);
    return { deduplicated: !created, capture: await this.view(capture) };
  }

  /** Reads the text again after a failure. Costs again, so the daily cap applies again. */
  async retry(id: string): Promise<CaptureView> {
    const c = await this.mustGet(id);
    if (c.state !== 'failed') {
      throw new HttpError(409, 'not_failed', '這筆沒有失敗，不需要重試。');
    }
    if (c.attemptCount >= this.cfg.maxAttempts) {
      throw new HttpError(409, 'too_many_attempts', '已經試過太多次了，請改寫內容後重新送出。');
    }
    const recent = await this.repo.recentSpendMicro();
    if (recent + c.estimatedCostMicro > this.cfg.dailyBudgetMicro) {
      this.overBudget(recent, c.estimatedCostMicro);
    }
    if (await this.repo.requeue(id)) await this.kick(id, `${id}:retry:${c.attemptCount}`);
    return this.view(await this.mustGet(id));
  }

  // ---- reading the text (runs in the engine) --------------------------------------------------

  /** One pass: claim, ask the AI once (with retries for trouble that passes), store the proposal. */
  async run(captureId: string): Promise<'done' | 'skipped'> {
    const c = await this.repo.claim(captureId, this.cfg.staleParsingMs);
    if (!c) return 'skipped';
    const attempt = c.attemptCount;
    if (attempt > this.cfg.maxAttempts) {
      await this.repo.finishFailed(captureId, attempt, {
        error: { code: 'too_many_attempts', message: '已經試過太多次了。' },
        costMicro: 0,
      });
      return 'done';
    }
    const prompt = capturePrompt({
      agentName: c.config.agentName,
      text: c.text,
      now: this.now(),
      timeZone: c.config.timeZone,
    });
    await this.repo.savePrompt(captureId, attempt, prompt);

    let last = 'Could not reach the AI.';
    for (let i = 1; i <= this.cfg.callTries; i += 1) {
      try {
        const r = await this.d.gateway.complete(c.config.agentId, prompt);
        if (r.status === 'failed') {
          await this.repo.finishFailed(captureId, attempt, {
            error: { code: r.code, message: FAILURES[r.code] ?? r.reason },
            costMicro: 0,
          });
          return 'done';
        }
        const cost = r.costMicro ?? 0;
        if (r.status === 'bad') {
          await this.repo.finishFailed(captureId, attempt, {
            error: { code: r.reason, message: FAILURES[r.reason] ?? 'AI 的回覆不能用。' },
            rawOutput: r.text,
            usage: r.usage,
            costMicro: cost,
          });
          return 'done';
        }
        const parsed = parseCaptureOutput(r.text, c.config.timeZone);
        if (!parsed.ok) {
          await this.repo.finishFailed(captureId, attempt, {
            error: { code: 'bad_format', message: FAILURES.bad_format! },
            rawOutput: r.text,
            usage: r.usage,
            costMicro: cost,
          });
          return 'done';
        }
        await this.repo.finishReady(captureId, attempt, {
          parsed: parsed.value,
          rawOutput: r.text,
          usage: r.usage,
          costMicro: cost,
        });
        return 'done';
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        last = err.message;
        if (i < this.cfg.callTries) await sleep(this.cfg.retryDelayMs);
      }
    }
    await this.repo.finishFailed(captureId, attempt, {
      error: { code: 'provider_unavailable', message: `${FAILURES.provider_unavailable} ${last}` },
      costMicro: 0,
    });
    return 'done';
  }

  /** Starts captures nobody is working on (a lost wake-up, a worker that died). */
  async reconcile(): Promise<number> {
    const list = await this.repo.listToReconcile(this.cfg.reconcileIdleMs);
    for (const c of list) {
      await this.repo.touchReconciled(c.id);
      await this.kick(
        c.id,
        `${c.id}:reconcile:${Math.floor(this.now().getTime() / this.cfg.reconcileIdleMs)}`,
      );
    }
    return list.length;
  }

  // ---- reading -------------------------------------------------------------------------------

  async get(id: string): Promise<CaptureView> {
    return this.view(await this.mustGet(id));
  }

  async list(limit = 30): Promise<CaptureView[]> {
    const rows = await this.repo.list(limit);
    const items = await this.repo.itemsFor(rows.map((r) => r.id));
    return rows.map((r) => this.toView(r, items.get(r.id) ?? []));
  }

  // ---- what the person does with an item -----------------------------------------------------

  async editItem(
    captureId: string,
    itemId: string,
    req: EditCaptureItemRequest,
  ): Promise<CaptureView> {
    const item = await this.mustItem(captureId, itemId);
    if (!['proposed', 'needs_info', 'failed'].includes(item.status)) {
      throw new HttpError(409, 'not_editable', '這一項已經處理過，不能再改。');
    }
    const next: ItemPayload = {
      ...item.payload,
      title: req.title ?? item.payload.title,
      note: req.note ?? item.payload.note,
      quantity: item.kind === 'shopping' ? (req.quantity ?? item.payload.quantity) : '',
    };
    let status: 'proposed' | 'needs_info' = 'proposed';
    let question = item.question;
    if (item.kind === 'event') {
      const wantsTime =
        req.startsAt !== undefined || req.endsAt !== undefined || req.allDay !== undefined;
      if (wantsTime) {
        const t = normalizeTimes(
          req.startsAt === undefined ? item.payload.startsAt : req.startsAt,
          req.endsAt === undefined ? item.payload.endsAt : req.endsAt,
          req.allDay ?? item.payload.allDay,
        );
        if (req.startsAt && !t.startsAt) {
          throw new HttpError(
            400,
            'invalid_time',
            '時間格式不對。請用「日期 時間」，例如 2026-10-20 15:00。',
          );
        }
        next.startsAt = t.startsAt;
        next.endsAt = t.endsAt;
        next.allDay = t.allDay;
      }
      if (!next.startsAt) {
        status = 'needs_info';
        question = question || '什麼時候？';
      } else {
        question = '';
      }
    }
    const saved = await this.repo.editItem(itemId, item.version, {
      payload: next,
      status,
      question,
    });
    if (!saved) throw new HttpError(409, 'item_changed', '這一項剛剛被更新了，請重新整理再改。');
    return this.get(captureId);
  }

  async rejectItem(captureId: string, itemId: string): Promise<CaptureItemResponse> {
    const item = await this.mustItem(captureId, itemId);
    if (item.status === 'writing') {
      throw new HttpError(409, 'writing', '這一項正在寫入，請稍後。');
    }
    const done = await this.repo.rejectItem(itemId);
    return { accepted: done !== null, capture: await this.get(captureId) };
  }

  /**
   * Approve exactly what the person saw, then write it. The first decision stands: a second tap, or
   * an item already saved or rejected, changes nothing and says so.
   */
  async approveItem(
    captureId: string,
    itemId: string,
    req: ApproveCaptureItemRequest,
  ): Promise<CaptureItemResponse> {
    const item = await this.mustItem(captureId, itemId);
    if (item.status === 'saved' || item.status === 'rejected') {
      return { accepted: false, capture: await this.get(captureId) };
    }
    if (item.status === 'needs_info') {
      throw new HttpError(409, 'needs_info', '這一項還缺必要資訊（例如時間），請先補上。');
    }
    const current = payloadHash(item.kind, item.payload);
    if (req.payloadHash !== current) {
      throw new HttpError(409, 'stale_item', '這一項的內容已經變了，請看過新的內容再核准。');
    }
    const claimed = await this.repo.claimItemForWrite(
      itemId,
      item.version,
      current,
      this.cfg.staleWritingMs,
    );
    if (!claimed) return { accepted: false, capture: await this.get(captureId) };
    await this.write(claimed);
    return { accepted: true, capture: await this.get(captureId) };
  }

  private async write(item: ItemRow): Promise<void> {
    const p = item.payload;
    if (item.kind === 'shopping') {
      await this.repo.saveShopping({
        captureItemId: item.id,
        captureId: item.captureId,
        title: p.title,
        note: p.note,
        quantity: p.quantity,
      });
      await this.repo.finishItem(item.id, {
        status: 'saved',
        result: { destination: 'little-boss-shopping', demo: false, link: null },
      });
      return;
    }

    let outcome;
    try {
      outcome = await this.d.calendar.insert({
        eventId: eventIdFor(item.id),
        title: p.title,
        description: p.note,
        startsAt: p.startsAt!,
        endsAt: p.endsAt,
        allDay: p.allDay,
        timeZone: p.timeZone,
      });
    } catch (err) {
      // Unknown outcome: it may or may not have been written. Retrying is safe (same event id).
      this.d.log?.('calendar write outcome unknown', err);
      await this.repo.finishItem(item.id, {
        status: 'failed',
        error: {
          code: 'unknown_outcome',
          message: '不確定有沒有寫進去。再按一次「核准」會用同一個編號重送，不會重複建立。',
        },
      });
      return;
    }
    if (outcome.status === 'failed') {
      await this.repo.finishItem(item.id, {
        status: 'failed',
        error: { code: outcome.code, message: outcome.reason },
      });
    } else if (outcome.status === 'not_connected') {
      await this.repo.finishItem(item.id, {
        status: 'failed',
        error: {
          code: 'not_connected',
          message: '還沒有連接 Google 行事曆，所以沒有寫入。連接後可以再按「核准」。',
        },
      });
    } else {
      await this.repo.finishItem(item.id, {
        status: 'saved',
        result: { destination: outcome.destination, demo: outcome.demo, link: outcome.link },
      });
    }
  }

  // ---- shopping list -------------------------------------------------------------------------

  async listShopping(): Promise<ShoppingItemView[]> {
    return (await this.repo.listShopping()).map(toShoppingView);
  }

  async setShoppingDone(id: string, done: boolean): Promise<ShoppingItemView> {
    const row = await this.repo.setShoppingDone(id, done);
    if (!row) throw new HttpError(404, 'not_found', '找不到這個項目。');
    return toShoppingView(row);
  }

  // ---- views ---------------------------------------------------------------------------------

  private async kick(id: string, key: string): Promise<void> {
    try {
      await this.d.engine.kick(id, key);
    } catch (err) {
      // The capture is saved; the reconcile sweep will start it.
      this.d.log?.('capture kick failed', err);
    }
  }

  private async mustGet(id: string): Promise<CaptureRow> {
    const c = await this.repo.get(id);
    if (!c) throw new HttpError(404, 'capture_not_found', '找不到這筆捕捉。');
    return c;
  }

  private async mustItem(captureId: string, itemId: string): Promise<ItemRow> {
    const item = await this.repo.getItem(itemId);
    if (!item || item.captureId !== captureId) {
      throw new HttpError(404, 'item_not_found', '找不到這一項。');
    }
    return item;
  }

  private async view(c: CaptureRow): Promise<CaptureView> {
    return this.toView(c, await this.repo.items(c.id));
  }

  private toView(c: CaptureRow, items: ItemRow[]): CaptureView {
    const now = this.now();
    return {
      id: c.id,
      text: c.text,
      state: c.state,
      agentId: c.config.agentId,
      error: c.error,
      items: items.map((i) => toItemView(i, now)),
      questions: c.questions,
      costMicro: c.costMicro ?? 0,
      estimatedCostMicro: c.estimatedCostMicro,
      attemptCount: c.attemptCount,
      createdAt: c.createdAt.toISOString(),
      finishedAt: c.finishedAt ? c.finishedAt.toISOString() : null,
    };
  }
}

function toItemView(i: ItemRow, now: Date): CaptureItemView {
  return {
    id: i.id,
    kind: i.kind,
    status: i.status,
    origin: i.origin,
    title: i.payload.title,
    note: i.payload.note,
    quantity: i.payload.quantity,
    startsAt: i.payload.startsAt,
    endsAt: i.payload.endsAt,
    allDay: i.payload.allDay,
    timeZone: i.payload.timeZone,
    assumptions: i.assumptions,
    question: i.question,
    warnings: warningsFor(i.kind, i.payload, now),
    payloadHash: payloadHash(i.kind, i.payload),
    result: i.result,
    error: i.error,
    approvedAt: i.approvedAt ? i.approvedAt.toISOString() : null,
  };
}

function toShoppingView(r: ShoppingRow): ShoppingItemView {
  return {
    id: r.id,
    title: r.title,
    note: r.note,
    quantity: r.quantity,
    done: r.done,
    captureId: r.captureId,
    createdAt: r.createdAt.toISOString(),
  };
}
