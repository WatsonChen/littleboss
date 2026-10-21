import type { Pool } from '../db/pool.js';

export interface FlowRow {
  id: string;
  template: string;
  title: string;
  notes: string;
  style: string;
  options: { title: string; description: string }[];
  chosen: { title: string; description: string } | null;
  publishAt: string | null;
  manualDone: Record<string, boolean>;
  aiCostMicro: number;
  createdAt: Date;
  updatedAt: Date;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toFlow = (r: Raw): FlowRow => ({
  id: r.id,
  template: r.template,
  title: r.title,
  notes: r.notes,
  style: r.style,
  options: r.options,
  chosen: r.chosen,
  publishAt: r.publish_at,
  manualDone: r.manual_done,
  aiCostMicro: Number(r.ai_cost_micro),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export class FlowRepository {
  constructor(private readonly pool: Pool) {}

  /** Creates a flow; a repeated `clientRequestId` returns the first one. */
  async create(n: {
    template: string;
    title: string;
    clientRequestId: string;
  }): Promise<{ flow: FlowRow; created: boolean }> {
    const { rows } = await this.pool.query(
      `insert into flows (template, title, client_request_id, style)
       values ($1,$2,$3, coalesce(
         (select style from flows where style <> '' order by updated_at desc limit 1), ''))
       on conflict (client_request_id) do nothing returning *`,
      [n.template, n.title, n.clientRequestId],
    );
    if (rows[0]) return { flow: toFlow(rows[0]), created: true };
    const { rows: dup } = await this.pool.query(`select * from flows where client_request_id=$1`, [
      n.clientRequestId,
    ]);
    return { flow: toFlow(dup[0]), created: false };
  }

  async get(id: string): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(`select * from flows where id=$1`, [id]);
    return rows[0] ? toFlow(rows[0]) : null;
  }

  /** Unfinished flows first is the caller's job; this is simply the most recently touched. */
  async list(limit: number): Promise<FlowRow[]> {
    const { rows } = await this.pool.query(
      `select * from flows order by updated_at desc limit $1`,
      [limit],
    );
    return rows.map(toFlow);
  }

  async saveInputs(
    id: string,
    v: { notes?: string; style?: string; title?: string },
  ): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(
      `update flows set notes = coalesce($2, notes), style = coalesce($3, style),
              title = coalesce($4, title), updated_at = now()
        where id=$1 returning *`,
      [id, v.notes ?? null, v.style ?? null, v.title ?? null],
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  async choose(
    id: string,
    chosen: { title: string; description: string },
  ): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(
      `update flows set chosen=$2, updated_at=now() where id=$1 returning *`,
      [id, JSON.stringify(chosen)],
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  async setSchedule(id: string, publishAt: string | null): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(
      `update flows set publish_at=$2, updated_at=now() where id=$1 returning *`,
      [id, publishAt],
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  /** Ticks or unticks one manual step. Atomic, so two quick taps on different steps both stay. */
  async setManualDone(id: string, key: string, done: boolean): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(
      `update flows set manual_done = jsonb_set(manual_done, $2::text[], $3::jsonb, true),
              updated_at = now()
        where id=$1 returning *`,
      [id, [key], JSON.stringify(done)],
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }

  // ---- AI calls ------------------------------------------------------------------------------

  /** Spend over the last 24 hours across all flows; used for the daily cap. */
  async recentSpendMicro(): Promise<number> {
    const { rows } = await this.pool.query(
      `select coalesce(sum(cost_micro), 0)::bigint as spent from flow_ai_calls
        where created_at > now() - interval '24 hours'`,
    );
    return Number(rows[0].spent);
  }

  /** Marks the flow busy. Only one caller wins; a call that died is replaced after `staleMs`. */
  async claimGenerating(id: string, staleMs: number): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update flows set generating_since = now()
        where id=$1 and (generating_since is null
              or generating_since < now() - ($2 || ' milliseconds')::interval)`,
      [id, String(staleMs)],
    );
    return (rowCount ?? 0) > 0;
  }

  async releaseGenerating(id: string): Promise<void> {
    await this.pool.query(`update flows set generating_since = null where id=$1`, [id]);
  }

  async recordCall(c: {
    flowId: string;
    agentId: string;
    model: string;
    costMicro: number;
    usage: unknown;
    rawOutput: string | null;
    outcome: 'ok' | 'bad_format' | 'failed';
  }): Promise<void> {
    await this.pool.query(
      `insert into flow_ai_calls (flow_id, agent_id, model, cost_micro, usage, raw_output, outcome)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        c.flowId,
        c.agentId,
        c.model,
        c.costMicro,
        c.usage ? JSON.stringify(c.usage) : null,
        c.rawOutput,
        c.outcome,
      ],
    );
    await this.pool.query(`update flows set ai_cost_micro = ai_cost_micro + $2 where id=$1`, [
      c.flowId,
      c.costMicro,
    ]);
  }

  async saveOptions(
    id: string,
    options: { title: string; description: string }[],
  ): Promise<FlowRow | null> {
    const { rows } = await this.pool.query(
      `update flows set options=$2, updated_at=now() where id=$1 returning *`,
      [id, JSON.stringify(options)],
    );
    return rows[0] ? toFlow(rows[0]) : null;
  }
}
