import type pg from 'pg';
import type { AgentId, RunOutcome, RunState } from '@littleboss/shared';
import type { Pool } from '../db/pool.js';
import type { HandoffInput } from '../core/handoff-flow.js';
import { HttpError } from '../discussion/errors.js';
import { SPENT_OF_MESSAGE, spentOfRuns } from '../discussion/repository.js';

export const ACTIVE_STATES: readonly RunState[] = ['running', 'waiting_input', 'waiting_approval'];
const ACTIVE_SQL = `('running','waiting_input','waiting_approval')`;

/** Settings frozen into a run when it starts. */
export interface RunConfigFrozen {
  roleId: 'executor';
  roleVersion: string;
  agentId: AgentId;
  agentName: string;
  model: string;
  /** Extra attempts after the first for trouble that may pass (timeouts, rate limits, 5xx). */
  maxRetries: number;
  maxOutputTokens: number;
}

export interface RunRow {
  id: string;
  threadId: string | null;
  kind: string;
  title: string;
  state: RunState;
  config: RunConfigFrozen;
  input: HandoffInput;
  outcome: RunOutcome | null;
  reservedMicro: number;
  clientRequestId: string | null;
  engineEventId: string | null;
  leaseUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface StepRow {
  runId: string;
  name: string;
  output: unknown;
  usage: unknown;
  costMicro: number;
  prompt: unknown;
  executions: number;
  createdAt: Date;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function toRun(r: Raw): RunRow {
  return {
    id: r.id,
    threadId: r.thread_id,
    kind: r.kind,
    title: r.title,
    state: r.state,
    config: r.config,
    input: r.input,
    outcome: r.outcome,
    reservedMicro: Number(r.reserved_micro),
    clientRequestId: r.client_request_id,
    engineEventId: r.engine_event_id,
    leaseUntil: r.lease_until,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
  };
}

function toStep(r: Raw): StepRow {
  return {
    runId: r.run_id,
    name: r.name,
    output: r.output,
    usage: r.usage,
    costMicro: Number(r.cost_micro),
    prompt: r.prompt,
    executions: r.executions,
    createdAt: r.created_at,
  };
}

export interface NewRun {
  threadId: string;
  kind: string;
  title: string;
  config: RunConfigFrozen;
  input: HandoffInput;
  reservedMicro: number;
  clientRequestId: string;
}

export interface SavedDeliverable {
  assetId: string;
  version: number;
}

export class RunRepository {
  constructor(private readonly pool: Pool) {}

  /**
   * Creates a run under the thread's lock, so the budget check and the reservation are one step:
   * two runs started together cannot both pass. Returns the existing run for a repeated
   * `clientRequestId` and starts nothing.
   */
  async create(
    n: NewRun,
    budgetCheck: (info: { limitMicro: number; spentMicro: number }) => void,
  ): Promise<{ run: RunRow; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rows: t } = await client.query(
        `select budget_limit_micro from threads where id=$1 for update`,
        [n.threadId],
      );
      if (!t[0]) throw new HttpError(404, 'thread_not_found', 'No such discussion.');
      const { rows: dup } = await client.query(
        `select * from runs where thread_id=$1 and client_request_id=$2`,
        [n.threadId, n.clientRequestId],
      );
      if (dup[0]) {
        await client.query('commit');
        return { run: toRun(dup[0]), created: false };
      }
      const { rows: s } = await client.query(
        `select (coalesce(sum(${SPENT_OF_MESSAGE}), 0) + ${spentOfRuns('$1')})::bigint as spent
           from thread_messages m where m.thread_id=$1`,
        [n.threadId],
      );
      budgetCheck({ limitMicro: Number(t[0].budget_limit_micro), spentMicro: Number(s[0].spent) });
      const { rows } = await client.query(
        `insert into runs (thread_id, kind, title, state, config, input, reserved_micro, client_request_id)
         values ($1,$2,$3,'running',$4,$5,$6,$7) returning *`,
        [
          n.threadId,
          n.kind,
          n.title,
          JSON.stringify(n.config),
          JSON.stringify(n.input),
          n.reservedMicro,
          n.clientRequestId,
        ],
      );
      await client.query(`update threads set updated_at=now() where id=$1`, [n.threadId]);
      await client.query('commit');
      return { run: toRun(rows[0]), created: true };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<RunRow | null> {
    const { rows } = await this.pool.query(`select * from runs where id=$1`, [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async listForThread(threadId: string): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `select * from runs where thread_id=$1 order by created_at desc`,
      [threadId],
    );
    return rows.map(toRun);
  }

  /** Runs that wait for the person, newest first. */
  async listWaiting(): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `select * from runs where state in ('waiting_input','waiting_approval') order by updated_at desc`,
    );
    return rows.map(toRun);
  }

  async getSteps(runId: string): Promise<StepRow[]> {
    const { rows } = await this.pool.query(
      `select * from run_steps where run_id=$1 order by created_at, name`,
      [runId],
    );
    return rows.map(toStep);
  }

  /** The first result for a step stands: a second writer gets the stored row back. */
  async recordStep(s: {
    runId: string;
    name: string;
    output: unknown;
    usage: unknown;
    costMicro: number;
    prompt: unknown;
    executions: number;
  }): Promise<StepRow> {
    const { rows } = await this.pool.query(
      `insert into run_steps (run_id, name, output, usage, cost_micro, prompt, executions)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (run_id, name) do nothing returning *`,
      [
        s.runId,
        s.name,
        JSON.stringify(s.output),
        s.usage === null || s.usage === undefined ? null : JSON.stringify(s.usage),
        s.costMicro,
        s.prompt === null || s.prompt === undefined ? null : JSON.stringify(s.prompt),
        s.executions,
      ],
    );
    if (rows[0]) return toStep(rows[0]);
    const { rows: existing } = await this.pool.query(
      `select * from run_steps where run_id=$1 and name=$2`,
      [s.runId, s.name],
    );
    return toStep(existing[0]);
  }

  /** Counts one more attempt at a step; returns the attempts so far, this one included. */
  async countAttempt(runId: string, name: string): Promise<number> {
    const { rows } = await this.pool.query(
      `insert into run_step_attempts (run_id, name, count) values ($1,$2,1)
       on conflict (run_id, name) do update set count = run_step_attempts.count + 1
       returning count`,
      [runId, name],
    );
    return rows[0].count as number;
  }

  async noteAttemptError(runId: string, name: string, message: string): Promise<void> {
    await this.pool.query(
      `update run_step_attempts set last_error=$3 where run_id=$1 and name=$2`,
      [runId, name, message.slice(0, 500)],
    );
  }

  async attemptsOf(
    runId: string,
  ): Promise<Record<string, { count: number; lastError: string | null }>> {
    const { rows } = await this.pool.query(
      `select name, count, last_error from run_step_attempts where run_id=$1`,
      [runId],
    );
    return Object.fromEntries(
      rows.map((r) => [
        r.name as string,
        { count: r.count as number, lastError: r.last_error as string | null },
      ]),
    );
  }

  async stateOf(runId: string): Promise<RunState | null> {
    const { rows } = await this.pool.query(`select state from runs where id=$1`, [runId]);
    return rows[0] ? (rows[0].state as RunState) : null;
  }

  // ---- lease: one driver at a time ------------------------------------------------------------

  /** Takes the run for `leaseMs` if it is active and nobody holds it. */
  async acquireLease(runId: string, leaseMs: number): Promise<RunRow | null> {
    const { rows } = await this.pool.query(
      `update runs set lease_until = now() + $2 * interval '1 millisecond'
        where id=$1 and state in ${ACTIVE_SQL} and (lease_until is null or lease_until < now())
        returning *`,
      [runId, leaseMs],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  async releaseLease(runId: string): Promise<void> {
    await this.pool.query(`update runs set lease_until = null where id=$1`, [runId]);
  }

  // ---- state ---------------------------------------------------------------------------------

  /** Moves an active run between waiting and running. Finished runs never move again. */
  async setActiveState(runId: string, state: 'running' | 'waiting_input' | 'waiting_approval') {
    await this.pool.query(
      `update runs set state=$2, updated_at=now() where id=$1 and state in ${ACTIVE_SQL} and state<>$2`,
      [runId, state],
    );
  }

  /** Ends an active run. Returns false when it had already ended (cancelled, or finished by another driver). */
  async finish(
    runId: string,
    state: Exclude<RunState, 'running' | 'waiting_input' | 'waiting_approval'>,
    outcome: RunOutcome,
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update runs set state=$2, outcome=$3, finished_at=now(), updated_at=now(), lease_until=null
        where id=$1 and state in ${ACTIVE_SQL}`,
      [runId, state, JSON.stringify(outcome)],
    );
    return (rowCount ?? 0) > 0;
  }

  async setEngineEvent(runId: string, eventId: string): Promise<void> {
    await this.pool.query(`update runs set engine_event_id=$2 where id=$1`, [runId, eventId]);
  }

  /** Active runs nobody is driving that may have work to do; used by the reconcile sweep. */
  async listToReconcile(minIdleMs: number): Promise<RunRow[]> {
    const { rows } = await this.pool.query(
      `select * from runs
        where state in ${ACTIVE_SQL}
          and (lease_until is null or lease_until < now())
          and updated_at < now() - $1 * interval '1 millisecond'
          and (reconciled_at is null or reconciled_at < now() - $1 * interval '1 millisecond')
        order by updated_at limit 50`,
      [minIdleMs],
    );
    return rows.map(toRun);
  }

  async touchReconciled(runId: string): Promise<void> {
    await this.pool.query(`update runs set reconciled_at=now() where id=$1`, [runId]);
  }

  // ---- what the person returned --------------------------------------------------------------

  static inputKey(runId: string, stepName: string): string {
    return `${runId}:${stepName}`;
  }

  /** The first answer wins. Returns true if this call stored it. */
  async insertInput(key: string, payload: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `insert into run_inputs (key, payload) values ($1,$2) on conflict (key) do nothing`,
      [key, payload],
    );
    return (rowCount ?? 0) > 0;
  }

  async getInput(key: string): Promise<string | null> {
    const { rows } = await this.pool.query(`select payload from run_inputs where key=$1`, [key]);
    return rows[0] ? (rows[0].payload as string) : null;
  }

  // ---- deliverable ---------------------------------------------------------------------------

  /** Saves the run's deliverable as a new asset. Doing it twice for one run returns the first. */
  async saveDeliverable(d: {
    runId: string;
    threadId: string | null;
    sourceAssetId: string;
    title: string;
    content: string;
  }): Promise<SavedDeliverable> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const existing = await this.deliverableOf(client, d.runId);
      if (existing) {
        await client.query('commit');
        return existing;
      }
      const { rows } = await client.query(
        `insert into assets (thread_id, kind, title, run_id, source_asset_id)
         values ($1,'deliverable',$2,$3,$4)
         on conflict (run_id) do nothing returning id`,
        [d.threadId, d.title, d.runId, d.sourceAssetId],
      );
      if (!rows[0]) {
        // Another writer created it between our check and insert.
        await client.query('rollback');
        const again = await this.deliverableOf(this.pool, d.runId);
        if (!again) throw new Error('deliverable vanished');
        return again;
      }
      await client.query(
        `insert into asset_versions (asset_id, version, content) values ($1, 1, $2)`,
        [rows[0].id, d.content],
      );
      if (d.threadId)
        await client.query(`update threads set updated_at=now() where id=$1`, [d.threadId]);
      await client.query('commit');
      return { assetId: rows[0].id as string, version: 1 };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async deliverableOf(
    q: Pick<pg.Pool | pg.PoolClient, 'query'>,
    runId: string,
  ): Promise<SavedDeliverable | null> {
    const { rows } = await q.query(
      `select a.id, coalesce(max(v.version), 0) as version
         from assets a left join asset_versions v on v.asset_id = a.id
        where a.run_id=$1 group by a.id`,
      [runId],
    );
    return rows[0] && rows[0].version > 0
      ? { assetId: rows[0].id as string, version: Number(rows[0].version) }
      : null;
  }

  /** The conclusion version to hand over; null when the thread has no such asset or version. */
  async getConclusion(
    threadId: string,
    assetId: string,
    version?: number,
  ): Promise<{ assetId: string; version: number; title: string; content: string } | null> {
    const { rows } = await this.pool.query(
      `select a.id, a.title, v.version, v.content
         from assets a join asset_versions v on v.asset_id = a.id
        where a.id=$1 and a.thread_id=$2 and a.kind='conclusion'
          and ($3::int is null or v.version=$3)
        order by v.version desc limit 1`,
      [assetId, threadId, version ?? null],
    );
    return rows[0]
      ? {
          assetId: rows[0].id,
          title: rows[0].title,
          version: rows[0].version,
          content: rows[0].content,
        }
      : null;
  }

  /** Costs of one run, from the recorded steps. */
  async costOf(runId: string): Promise<number> {
    const { rows } = await this.pool.query(
      `select coalesce(sum(cost_micro),0)::bigint as c from run_steps where run_id=$1`,
      [runId],
    );
    return Number(rows[0].c);
  }
}
