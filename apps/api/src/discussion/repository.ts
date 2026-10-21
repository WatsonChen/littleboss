import type pg from 'pg';
import type { AgentId, AssetVersionView, MessageView, ThreadSummary } from '@littleboss/shared';
import { HttpError } from './errors.js';
import type { Pool } from '../db/pool.js';

export type Role = 'user' | 'context' | 'agent';
export type Status = MessageView['status'];

export interface MessageRow {
  id: string;
  threadId: string;
  seq: number;
  role: Role;
  agentId: AgentId | null;
  replyToId: string | null;
  triggerId: string | null;
  content: string;
  status: Status;
  seenMessageIds: string[];
  agentConfig: unknown;
  prompt: unknown;
  injectedMemory: unknown[];
  usage: unknown;
  estimatedCostMicro: number | null;
  costMicro: number | null;
  costIsEstimate: boolean;
  error: { code: string; message: string } | null;
  attemptCount: number;
  attempts: unknown[];
  editedByUser: boolean;
  createdAt: Date;
  queuedAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  autoPlan: AutoPlan | null;
  autoTurn: number | null;
  autoKind: AutoKind | null;
  autoDone: boolean | null;
  reviewAssetId: string | null;
  reviewVersion: number | null;
}

export type AutoKind = NonNullable<MessageView['autoKind']>;
/** Who speaks in which turn of an automatic discussion, and who writes the summary. Frozen at send. */
export interface AutoPlan {
  order: AgentId[];
  summarizer: AgentId | null;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function toRow(r: Raw): MessageRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    seq: r.seq,
    role: r.role,
    agentId: r.agent_id,
    replyToId: r.reply_to_id,
    triggerId: r.trigger_id,
    content: r.content,
    status: r.status,
    seenMessageIds: r.seen_message_ids,
    agentConfig: r.agent_config,
    prompt: r.prompt,
    injectedMemory: r.injected_memory,
    usage: r.usage,
    estimatedCostMicro: n(r.estimated_cost_micro),
    costMicro: n(r.cost_micro),
    costIsEstimate: r.cost_is_estimate,
    error: r.error,
    attemptCount: r.attempt_count,
    attempts: r.attempts,
    editedByUser: r.edited_by_user,
    createdAt: r.created_at,
    queuedAt: r.queued_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    autoPlan: r.auto_plan,
    autoTurn: r.auto_turn,
    autoKind: r.auto_kind,
    autoDone: r.auto_done,
    reviewAssetId: r.review_asset_id,
    reviewVersion: r.review_version,
  };
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toView(m: MessageRow): MessageView {
  return {
    id: m.id,
    threadId: m.threadId,
    seq: m.seq,
    role: m.role,
    agentId: m.agentId,
    replyToId: m.replyToId,
    triggerId: m.triggerId,
    autoKind: m.autoKind,
    autoDone: m.autoDone,
    content: m.content,
    status: m.status,
    error: m.error,
    seenMessageIds: m.seenMessageIds,
    estimatedCostMicro: m.estimatedCostMicro,
    costMicro: m.costMicro,
    costIsEstimate: m.costIsEstimate,
    attemptCount: m.attemptCount,
    editedByUser: m.editedByUser,
    createdAt: m.createdAt.toISOString(),
    queuedAt: iso(m.queuedAt),
    startedAt: iso(m.startedAt),
    finishedAt: iso(m.finishedAt),
  };
}

/**
 * What a message has cost so far: the real cost when known, otherwise its estimate, plus what its
 * earlier (retried) attempts cost. Used for the budget, so it errs towards counting too much.
 */
export const SPENT_OF_MESSAGE = `
  coalesce(m.cost_micro, m.estimated_cost_micro, 0)
  + coalesce((select sum(coalesce((a->>'costMicro')::bigint, 0)) from jsonb_array_elements(m.attempts) a), 0)`;

/**
 * What the thread's runs have cost. A run that is still active counts the larger of what is set
 * aside for it and what it has really spent; a finished run counts only what it really spent.
 */
export const spentOfRuns = (threadIdExpr: string) => `
  (select coalesce(sum(case when r.state in ('running','waiting_input','waiting_approval')
            then greatest(r.reserved_micro, rc.cost) else rc.cost end), 0)
     from runs r
     left join lateral (select coalesce(sum(s.cost_micro), 0) as cost from run_steps s where s.run_id = r.id) rc on true
    where r.thread_id = ${threadIdExpr})`;

export interface NewMessage {
  role: Role;
  agentId?: AgentId;
  replyToId?: string;
  triggerId?: string;
  content: string;
  /** 'failed' is for an automatic turn that could not be afforded: it is shown and can be retried. */
  status: 'sent' | 'queued' | 'failed';
  error?: { code: string; message: string };
  clientRequestId?: string;
  seenMessageIds?: string[];
  agentConfig?: unknown;
  estimatedCostMicro?: number;
  autoPlan?: AutoPlan;
  autoTurn?: number;
  autoKind?: AutoKind;
  reviewAssetId?: string;
  reviewVersion?: number;
}

export interface ThreadSettings {
  participants: AgentId[];
  reviewer: AgentId | null;
  maxRounds: number;
}

export interface Finish {
  status: 'succeeded' | 'failed' | 'timed_out' | 'bad_format';
  content: string;
  error: { code: string; message: string } | null;
  usage: unknown;
  costMicro: number | null;
  costIsEstimate: boolean;
  autoDone?: boolean | null;
}

/** Work done while holding the thread's row lock, so sequence numbers and the budget stay consistent. */
export class ThreadTx {
  constructor(
    private readonly c: pg.PoolClient,
    readonly threadId: string,
    readonly budgetLimitMicro: number,
    readonly settings: ThreadSettings,
  ) {}

  async findByRequestId(clientRequestId: string): Promise<MessageRow[]> {
    const { rows } = await this.c.query(
      `select * from thread_messages where thread_id=$1 and client_request_id=$2`,
      [this.threadId, clientRequestId],
    );
    if (rows.length === 0) return [];
    const first = toRow(rows[0]);
    const { rows: calls } = await this.c.query(
      `select * from thread_messages where trigger_id=$1 order by seq`,
      [first.id],
    );
    return [first, ...calls.map(toRow)];
  }

  async messages(): Promise<MessageRow[]> {
    const { rows } = await this.c.query(
      `select * from thread_messages where thread_id=$1 order by seq`,
      [this.threadId],
    );
    return rows.map(toRow);
  }

  async spentMicro(): Promise<number> {
    const { rows } = await this.c.query(
      `select (coalesce(sum(${SPENT_OF_MESSAGE}), 0) + ${spentOfRuns('$1')})::bigint as spent
         from thread_messages m where m.thread_id=$1`,
      [this.threadId],
    );
    return Number(rows[0].spent);
  }

  async insert(msgs: NewMessage[]): Promise<MessageRow[]> {
    const out: MessageRow[] = [];
    for (const m of msgs) out.push((await this.insertOne(m, false))!);
    await this.c.query(`update threads set updated_at=now() where id=$1`, [this.threadId]);
    return out;
  }

  /** Inserts unless this exact turn (or review) already exists; returns null in that case. */
  async insertOnce(m: NewMessage): Promise<MessageRow | null> {
    const row = await this.insertOne(m, true);
    if (row) await this.c.query(`update threads set updated_at=now() where id=$1`, [this.threadId]);
    return row;
  }

  private async insertOne(m: NewMessage, skipConflict: boolean): Promise<MessageRow | null> {
    const { rows: seqRows } = await this.c.query(
      `select coalesce(max(seq), 0)::int as s from thread_messages where thread_id=$1`,
      [this.threadId],
    );
    const { rows } = await this.c.query(
      `insert into thread_messages
         (thread_id, seq, role, agent_id, reply_to_id, trigger_id, content, status, client_request_id,
          seen_message_ids, agent_config, estimated_cost_micro, queued_at, error, finished_at,
          auto_plan, auto_turn, auto_kind, review_asset_id, review_version, cost_micro, cost_is_estimate)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, case when $8='queued' then now() end,
               $13, case when $8='failed' then now() end, $14,$15,$16,$17,$18,
               case when $8='failed' then 0 end, case when $8='failed' then false else true end)
       ${skipConflict ? 'on conflict do nothing' : ''}
       returning *`,
      [
        this.threadId,
        seqRows[0].s + 1,
        m.role,
        m.agentId ?? null,
        m.replyToId ?? null,
        m.triggerId ?? null,
        m.content,
        m.status,
        m.clientRequestId ?? null,
        m.seenMessageIds ?? [],
        m.agentConfig === undefined ? null : JSON.stringify(m.agentConfig),
        m.estimatedCostMicro ?? null,
        m.error ? JSON.stringify(m.error) : null,
        m.autoPlan ? JSON.stringify(m.autoPlan) : null,
        m.autoTurn ?? null,
        m.autoKind ?? null,
        m.reviewAssetId ?? null,
        m.reviewVersion ?? null,
      ],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** The AI turns an automatic discussion has produced so far, in order. */
  async turnsOf(triggerId: string): Promise<MessageRow[]> {
    const { rows } = await this.c.query(
      `select * from thread_messages where trigger_id=$1 and role='agent' and auto_turn is not null
        order by auto_turn`,
      [triggerId],
    );
    return rows.map(toRow);
  }

  /**
   * Puts a failed, bad-format or lost call back in the queue and keeps what happened before.
   * Returns null when the message is not in a state that may be retried.
   */
  async requeue(
    messageId: string,
    estimatedCostMicro: number,
    staleQueuedMs: number,
    staleRunningMs: number,
  ): Promise<MessageRow | null> {
    const { rows } = await this.c.query(
      `update thread_messages set
         attempts = attempts || jsonb_build_array(jsonb_build_object(
           'attempt', attempt_count, 'status', status, 'error', error, 'content', content,
           'costMicro', coalesce(cost_micro, estimated_cost_micro), 'usage', usage,
           'startedAt', started_at, 'finishedAt', finished_at)),
         status='queued', error=null, content='', usage=null, cost_micro=null,
         estimated_cost_micro=$2, cost_is_estimate=true,
         queued_at=now(), started_at=null, finished_at=null
       where id=$1 and thread_id=$5 and role='agent' and (
         status in ('failed','timed_out','bad_format')
         or (status='queued' and queued_at < now() - $3 * interval '1 millisecond')
         or (status='running' and started_at < now() - $4 * interval '1 millisecond'))
       returning *`,
      [messageId, estimatedCostMicro, staleQueuedMs, staleRunningMs, this.threadId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  /** A person fixes a reply that came back unusable; the original text is kept in the attempts. */
  async editBadFormat(messageId: string, content: string): Promise<MessageRow | null> {
    const { rows } = await this.c.query(
      `update thread_messages set
         attempts = attempts || jsonb_build_array(jsonb_build_object(
           'attempt', attempt_count, 'status', status, 'error', error, 'content', content, 'editedByUser', true)),
         content=$2, status='succeeded', error=null, edited_by_user=true
       where id=$1 and thread_id=$3 and role='agent' and status='bad_format'
       returning *`,
      [messageId, content, this.threadId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async saveConclusion(input: {
    title: string;
    content: string;
    sourceMessageIds: string[];
    assetId?: string;
  }): Promise<AssetVersionView> {
    const { rows: found } = await this.c.query(
      `select id from thread_messages where thread_id=$1 and id = any($2::uuid[])`,
      [this.threadId, input.sourceMessageIds],
    );
    if (found.length !== new Set(input.sourceMessageIds).size) {
      throw new HttpError(400, 'bad_source', 'Some source messages are not in this thread.');
    }
    let assetId = input.assetId;
    let title = input.title;
    if (assetId) {
      const { rows } = await this.c.query(
        `select id, title from assets where id=$1 and thread_id=$2 and kind='conclusion' for update`,
        [assetId, this.threadId],
      );
      if (!rows[0])
        throw new HttpError(404, 'asset_not_found', 'No such saved conclusion in this thread.');
      title = input.title || rows[0].title;
    } else {
      const { rows } = await this.c.query(
        `insert into assets (thread_id, kind, title) values ($1, 'conclusion', $2) returning id`,
        [this.threadId, input.title],
      );
      assetId = rows[0].id as string;
    }
    const { rows } = await this.c.query(
      `insert into asset_versions (asset_id, version, content, source_message_ids)
       values ($1, (select coalesce(max(version), 0) + 1 from asset_versions where asset_id=$1), $2, $3)
       returning version, created_at`,
      [assetId, input.content, input.sourceMessageIds],
    );
    if (input.assetId)
      await this.c.query(`update assets set title=$2 where id=$1`, [assetId, title]);
    await this.c.query(`update threads set updated_at=now() where id=$1`, [this.threadId]);
    return {
      assetId: assetId!,
      kind: 'conclusion',
      title,
      version: rows[0].version,
      content: input.content,
      sourceMessageIds: input.sourceMessageIds,
      createdAt: rows[0].created_at.toISOString(),
    };
  }
}

export class DiscussionRepository {
  constructor(private readonly pool: Pool) {}

  async createThread(
    title: string,
    budgetLimitMicro: number,
    s: ThreadSettings = { participants: [], reviewer: null, maxRounds: 3 },
  ): Promise<ThreadSummary> {
    const { rows } = await this.pool.query(
      `insert into threads (title, budget_limit_micro, participants, reviewer, max_rounds)
       values ($1,$2,$3,$4,$5) returning id`,
      [title, budgetLimitMicro, s.participants, s.reviewer, s.maxRounds],
    );
    return (await this.getThread(rows[0].id))!;
  }

  private async threadSummaries(where: string, params: unknown[]): Promise<ThreadSummary[]> {
    const { rows } = await this.pool.query(
      `select t.id, t.title, t.budget_limit_micro, t.updated_at, t.participants, t.reviewer, t.max_rounds,
         (select count(*) from thread_messages m where m.thread_id = t.id)::int as message_count,
         ((select coalesce(sum(${SPENT_OF_MESSAGE}), 0) from thread_messages m where m.thread_id = t.id)
           + ${spentOfRuns('t.id')})::bigint as spent
       from threads t ${where} order by t.updated_at desc`,
      params,
    );
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      budgetLimitMicro: Number(r.budget_limit_micro),
      spentMicro: Number(r.spent),
      updatedAt: r.updated_at.toISOString(),
      messageCount: r.message_count,
      participants: r.participants,
      reviewer: r.reviewer,
      maxRounds: r.max_rounds,
    }));
  }

  async renameThread(id: string, title: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(`update threads set title=$2 where id=$1`, [
      id,
      title,
    ]);
    return (rowCount ?? 0) > 0;
  }

  listThreads(): Promise<ThreadSummary[]> {
    return this.threadSummaries('', []);
  }

  async getThread(id: string): Promise<ThreadSummary | null> {
    return (await this.threadSummaries('where t.id = $1', [id]))[0] ?? null;
  }

  async listMessages(threadId: string): Promise<MessageRow[]> {
    const { rows } = await this.pool.query(
      `select * from thread_messages where thread_id=$1 order by seq`,
      [threadId],
    );
    return rows.map(toRow);
  }

  async getMessage(id: string): Promise<MessageRow | null> {
    const { rows } = await this.pool.query(`select * from thread_messages where id=$1`, [id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getMessagesByIds(ids: string[]): Promise<MessageRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query(
      `select * from thread_messages where id = any($1::uuid[]) order by seq`,
      [ids],
    );
    return rows.map(toRow);
  }

  /** Runs `fn` while holding the thread's row lock; throws 404 if the thread does not exist. */
  async withThread<T>(threadId: string, fn: (tx: ThreadTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows } = await client.query(
        `select budget_limit_micro, participants, reviewer, max_rounds from threads where id=$1 for update`,
        [threadId],
      );
      if (!rows[0]) throw new HttpError(404, 'thread_not_found', 'No such discussion.');
      const out = await fn(
        new ThreadTx(client, threadId, Number(rows[0].budget_limit_micro), {
          participants: rows[0].participants,
          reviewer: rows[0].reviewer,
          maxRounds: rows[0].max_rounds,
        }),
      );
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Takes the call for this process. Only one caller can win: a queued call, or a running call
   * whose worker has been silent for `staleRunningMs`. Everyone else gets null.
   */
  async claim(messageId: string, staleRunningMs: number): Promise<MessageRow | null> {
    const { rows } = await this.pool.query(
      `update thread_messages set status='running', started_at=now(), attempt_count=attempt_count+1
       where id=$1 and role='agent' and (status='queued'
         or (status='running' and started_at < now() - $2 * interval '1 millisecond'))
       returning *`,
      [messageId, staleRunningMs],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async savePrompt(messageId: string, attempt: number, prompt: unknown): Promise<void> {
    await this.pool.query(
      `update thread_messages set prompt=$3 where id=$1 and status='running' and attempt_count=$2`,
      [messageId, attempt, JSON.stringify(prompt)],
    );
  }

  /** Records the outcome of attempt `attempt`. Ignored if a newer attempt has taken over. */
  async finish(messageId: string, attempt: number, f: Finish): Promise<MessageRow | null> {
    const { rows } = await this.pool.query(
      `update thread_messages set status=$3, content=$4, error=$5, usage=$6,
         cost_micro=$7, cost_is_estimate=$8, finished_at=now(), auto_done=$9
       where id=$1 and status='running' and attempt_count=$2
       returning *`,
      [
        messageId,
        attempt,
        f.status,
        f.content,
        f.error ? JSON.stringify(f.error) : null,
        f.usage === null || f.usage === undefined ? null : JSON.stringify(f.usage),
        f.costMicro,
        f.costIsEstimate,
        f.autoDone ?? null,
      ],
    );
    if (rows[0])
      await this.pool.query(`update threads set updated_at=now() where id=$1`, [rows[0].thread_id]);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async listAssets(threadId: string): Promise<AssetVersionView[]> {
    const { rows } = await this.pool.query(
      `select a.id as asset_id, a.kind, a.title, v.version, v.content, v.source_message_ids, v.created_at
         from assets a join asset_versions v on v.asset_id = a.id
        where a.thread_id=$1 order by a.created_at, a.id, v.version desc`,
      [threadId],
    );
    return rows.map((r) => ({
      assetId: r.asset_id,
      kind: r.kind,
      title: r.title,
      version: r.version,
      content: r.content,
      sourceMessageIds: r.source_message_ids,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async getAssetVersion(
    assetId: string,
    version: number,
  ): Promise<{ title: string; content: string } | null> {
    const { rows } = await this.pool.query(
      `select a.title, v.content from assets a join asset_versions v on v.asset_id=a.id
        where a.id=$1 and v.version=$2`,
      [assetId, version],
    );
    return rows[0] ? { title: rows[0].title, content: rows[0].content } : null;
  }

  /** Discussion turns that finished but whose next step was never created (a lost hand-off). */
  async listStalledTurns(minIdleMs: number): Promise<MessageRow[]> {
    const { rows } = await this.pool.query(
      `select m.* from thread_messages m
        join thread_messages t on t.id = m.trigger_id
        where m.role='agent' and m.auto_kind='discussion' and m.status='succeeded'
          and m.finished_at < now() - $1 * interval '1 millisecond'
          and m.finished_at > now() - interval '1 day'
          -- a chain without a summary is over once its last planned turn is done
          and ((t.auto_plan->>'summarizer') is not null
               or m.auto_turn + 1 < jsonb_array_length(t.auto_plan->'order'))
          and not exists (select 1 from thread_messages n
                           where n.trigger_id = m.trigger_id and n.auto_turn = m.auto_turn + 1)
        order by m.finished_at limit 50`,
      [minIdleMs],
    );
    return rows.map(toRow);
  }

  /** Calls that were queued but never handed to a worker. */
  async listLostQueued(minIdleMs: number): Promise<MessageRow[]> {
    const { rows } = await this.pool.query(
      `select * from thread_messages
        where role='agent' and status='queued' and attempt_count=0
          and queued_at < now() - $1 * interval '1 millisecond'
        order by queued_at limit 50`,
      [minIdleMs],
    );
    return rows.map(toRow);
  }

  health() {
    const pool = this.pool;
    return {
      query: (sql: string) => pool.query(sql),
      async countMigrations(): Promise<number | null> {
        try {
          const { rows } = await pool.query(`select count(*)::int as n from schema_migrations`);
          return rows[0].n as number;
        } catch {
          return null;
        }
      },
    };
  }
}
