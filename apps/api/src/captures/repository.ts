import type pg from 'pg';
import type { AgentId } from '@littleboss/shared';
import type { Pool } from '../db/pool.js';
import { HttpError } from '../discussion/errors.js';
import type { ItemPayload, ParsedCapture } from './parse.js';

export type CaptureState = 'queued' | 'parsing' | 'ready' | 'failed';
export type ItemStatus = 'proposed' | 'needs_info' | 'rejected' | 'writing' | 'saved' | 'failed';

export interface CaptureConfig {
  roleVersion: string;
  agentId: AgentId;
  agentName: string;
  model: string;
  timeZone: string;
}

export interface CaptureRow {
  id: string;
  text: string;
  state: CaptureState;
  clientRequestId: string;
  config: CaptureConfig;
  error: { code: string; message: string } | null;
  questions: string[];
  attemptCount: number;
  estimatedCostMicro: number;
  costMicro: number | null;
  createdAt: Date;
  startedAt: Date | null;
  updatedAt: Date;
  finishedAt: Date | null;
}

export interface ItemResult {
  destination: 'little-boss-shopping' | 'google-calendar' | 'demo-calendar';
  demo: boolean;
  link: string | null;
}

export interface ItemRow {
  id: string;
  captureId: string;
  position: number;
  kind: 'shopping' | 'event';
  origin: 'said' | 'suggested';
  status: ItemStatus;
  payload: ItemPayload;
  assumptions: string[];
  question: string;
  approvedHash: string | null;
  approvedAt: Date | null;
  result: ItemResult | null;
  error: { code: string; message: string } | null;
  /** Counts every change; "I saw version N" is checked against it. */
  version: number;
  updatedAt: Date;
}

export interface ShoppingRow {
  id: string;
  title: string;
  note: string;
  quantity: string;
  done: boolean;
  captureId: string | null;
  createdAt: Date;
}

type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const toCapture = (r: Raw): CaptureRow => ({
  id: r.id,
  text: r.text,
  state: r.state,
  clientRequestId: r.client_request_id,
  config: r.config,
  error: r.error,
  questions: r.questions,
  attemptCount: r.attempt_count,
  estimatedCostMicro: Number(r.estimated_cost_micro),
  costMicro: r.cost_micro === null ? null : Number(r.cost_micro),
  createdAt: r.created_at,
  startedAt: r.started_at,
  updatedAt: r.updated_at,
  finishedAt: r.finished_at,
});

const toItem = (r: Raw): ItemRow => ({
  id: r.id,
  captureId: r.capture_id,
  position: r.position,
  kind: r.kind,
  origin: r.origin,
  status: r.status,
  payload: r.payload,
  assumptions: r.assumptions,
  question: r.question,
  approvedHash: r.approved_hash,
  approvedAt: r.approved_at,
  result: r.result,
  error: r.error,
  version: Number(r.version),
  updatedAt: r.updated_at,
});

const toShopping = (r: Raw): ShoppingRow => ({
  id: r.id,
  title: r.title,
  note: r.note,
  quantity: r.quantity,
  done: r.done,
  captureId: r.capture_id,
  createdAt: r.created_at,
});

/** What this app has spent on captures lately; active ones count at least their estimate. */
const RECENT_SPEND = `
  select coalesce(sum(case when state in ('queued','parsing')
           then greatest(coalesce(cost_micro, 0), estimated_cost_micro)
           else coalesce(cost_micro, 0) end), 0)::bigint as spent
    from captures where created_at > now() - interval '24 hours'`;

export class CaptureRepository {
  constructor(private readonly pool: Pool) {}

  /** Spend over the last 24 hours; used for the daily cap. */
  async recentSpendMicro(q: Pick<pg.Pool | pg.PoolClient, 'query'> = this.pool): Promise<number> {
    const { rows } = await q.query(RECENT_SPEND);
    return Number(rows[0].spent);
  }

  /**
   * Creates the capture under a lock so the daily cap check and the insert are one step.
   * A repeated `clientRequestId` returns the first capture and starts nothing.
   */
  async create(
    n: { text: string; clientRequestId: string; config: CaptureConfig; estimatedCostMicro: number },
    budgetCheck: (recentSpendMicro: number) => void,
  ): Promise<{ capture: CaptureRow; created: boolean }> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext('littleboss-captures'))`);
      const { rows: dup } = await client.query(
        `select * from captures where client_request_id=$1`,
        [n.clientRequestId],
      );
      if (dup[0]) {
        await client.query('commit');
        return { capture: toCapture(dup[0]), created: false };
      }
      budgetCheck(await this.recentSpendMicro(client));
      const { rows } = await client.query(
        `insert into captures (text, state, client_request_id, config, estimated_cost_micro)
         values ($1,'queued',$2,$3,$4) returning *`,
        [n.text, n.clientRequestId, JSON.stringify(n.config), n.estimatedCostMicro],
      );
      await client.query('commit');
      return { capture: toCapture(rows[0]), created: true };
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<CaptureRow | null> {
    const { rows } = await this.pool.query(`select * from captures where id=$1`, [id]);
    return rows[0] ? toCapture(rows[0]) : null;
  }

  async list(limit: number): Promise<CaptureRow[]> {
    const { rows } = await this.pool.query(
      `select * from captures order by created_at desc limit $1`,
      [limit],
    );
    return rows.map(toCapture);
  }

  async items(captureId: string): Promise<ItemRow[]> {
    const { rows } = await this.pool.query(
      `select * from capture_items where capture_id=$1 order by position`,
      [captureId],
    );
    return rows.map(toItem);
  }

  async itemsFor(captureIds: string[]): Promise<Map<string, ItemRow[]>> {
    const out = new Map<string, ItemRow[]>(captureIds.map((id) => [id, []]));
    if (captureIds.length === 0) return out;
    const { rows } = await this.pool.query(
      `select * from capture_items where capture_id = any($1::uuid[]) order by capture_id, position`,
      [captureIds],
    );
    for (const r of rows) out.get(r.capture_id)!.push(toItem(r));
    return out;
  }

  async getItem(id: string): Promise<ItemRow | null> {
    const { rows } = await this.pool.query(`select * from capture_items where id=$1`, [id]);
    return rows[0] ? toItem(rows[0]) : null;
  }

  // ---- reading the text (the one model call) ------------------------------------------------

  /** Takes the capture for this process. Only one caller wins; a silent worker can be replaced. */
  async claim(id: string, staleMs: number): Promise<CaptureRow | null> {
    const { rows } = await this.pool.query(
      `update captures set state='parsing', started_at=now(), updated_at=now(),
         attempt_count=attempt_count+1
       where id=$1 and (state='queued'
         or (state='parsing' and started_at < now() - $2 * interval '1 millisecond'))
       returning *`,
      [id, staleMs],
    );
    return rows[0] ? toCapture(rows[0]) : null;
  }

  async savePrompt(id: string, attempt: number, prompt: unknown): Promise<void> {
    await this.pool.query(
      `update captures set prompt=$3 where id=$1 and state='parsing' and attempt_count=$2`,
      [id, attempt, JSON.stringify(prompt)],
    );
  }

  /** Stores the proposed items. Ignored if a newer attempt has taken over. */
  async finishReady(
    id: string,
    attempt: number,
    r: {
      parsed: ParsedCapture;
      rawOutput: string;
      usage: unknown;
      costMicro: number;
    },
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const { rowCount } = await client.query(
        `update captures set state='ready', questions=$3, raw_output=$4, usage=$5,
           cost_micro=coalesce(cost_micro,0)+$6, error=null, finished_at=now(), updated_at=now()
         where id=$1 and state='parsing' and attempt_count=$2`,
        [
          id,
          attempt,
          JSON.stringify(r.parsed.questions),
          r.rawOutput,
          JSON.stringify(r.usage),
          r.costMicro,
        ],
      );
      if (!rowCount) {
        await client.query('rollback');
        return false;
      }
      let position = 0;
      for (const it of r.parsed.items) {
        await client.query(
          `insert into capture_items (capture_id, position, kind, origin, status, payload, assumptions, question)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            id,
            position++,
            it.kind,
            it.origin,
            it.needsInfo ? 'needs_info' : 'proposed',
            JSON.stringify(it.payload),
            JSON.stringify(it.assumptions),
            it.question,
          ],
        );
      }
      await client.query('commit');
      return true;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async finishFailed(
    id: string,
    attempt: number,
    f: {
      error: { code: string; message: string };
      rawOutput?: string;
      usage?: unknown;
      costMicro: number;
    },
  ): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update captures set state='failed', error=$3, raw_output=$4, usage=$5,
         cost_micro=coalesce(cost_micro,0)+$6, finished_at=now(), updated_at=now()
       where id=$1 and state='parsing' and attempt_count=$2`,
      [
        id,
        attempt,
        JSON.stringify(f.error),
        f.rawOutput ?? null,
        f.usage === undefined || f.usage === null ? null : JSON.stringify(f.usage),
        f.costMicro,
      ],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Puts a failed capture back in the queue (the person asked to try again). */
  async requeue(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `update captures set state='queued', error=null, finished_at=null, updated_at=now()
        where id=$1 and state='failed'`,
      [id],
    );
    return (rowCount ?? 0) > 0;
  }

  async listToReconcile(minIdleMs: number): Promise<CaptureRow[]> {
    const { rows } = await this.pool.query(
      `select * from captures
        where state in ('queued','parsing')
          and updated_at < now() - $1 * interval '1 millisecond'
          and (reconciled_at is null or reconciled_at < now() - $1 * interval '1 millisecond')
        order by updated_at limit 50`,
      [minIdleMs],
    );
    return rows.map(toCapture);
  }

  async touchReconciled(id: string): Promise<void> {
    await this.pool.query(`update captures set reconciled_at=now() where id=$1`, [id]);
  }

  // ---- items ---------------------------------------------------------------------------------

  /** Replaces what the person sees for an item that has not been written. Clears any approval. */
  async editItem(
    itemId: string,
    expectVersion: number,
    p: { payload: ItemPayload; status: 'proposed' | 'needs_info'; question: string },
  ): Promise<ItemRow | null> {
    const { rows } = await this.pool.query(
      `update capture_items set payload=$3, status=$4, question=$5, approved_hash=null,
         approved_at=null, error=null, updated_at=now(), version=version+1
        where id=$1 and version=$2 and status in ('proposed','needs_info','failed')
        returning *`,
      [itemId, expectVersion, JSON.stringify(p.payload), p.status, p.question],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  async rejectItem(itemId: string): Promise<ItemRow | null> {
    const { rows } = await this.pool.query(
      `update capture_items set status='rejected', updated_at=now(), version=version+1
        where id=$1 and status in ('proposed','needs_info','failed') returning *`,
      [itemId],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  /**
   * The person approved exactly this content: take the item for writing. Only one caller wins; an
   * item stuck in `writing` (a worker died) can be taken again because writes are idempotent.
   */
  async claimItemForWrite(
    itemId: string,
    expectVersion: number,
    hash: string,
    staleMs: number,
  ): Promise<ItemRow | null> {
    const { rows } = await this.pool.query(
      `update capture_items set status='writing', approved_hash=$3, approved_at=now(),
         error=null, updated_at=now(), version=version+1
        where id=$1 and version=$2
          and (status in ('proposed','failed')
               or (status='writing' and updated_at < now() - $4 * interval '1 millisecond'))
        returning *`,
      [itemId, expectVersion, hash, staleMs],
    );
    return rows[0] ? toItem(rows[0]) : null;
  }

  async finishItem(
    itemId: string,
    f:
      | { status: 'saved'; result: ItemResult }
      | { status: 'failed'; error: { code: string; message: string } },
  ): Promise<void> {
    await this.pool.query(
      `update capture_items set status=$2, result=$3, error=$4, updated_at=now(), version=version+1
        where id=$1 and status='writing'`,
      [
        itemId,
        f.status,
        f.status === 'saved' ? JSON.stringify(f.result) : null,
        f.status === 'failed' ? JSON.stringify(f.error) : null,
      ],
    );
  }

  // ---- shopping list --------------------------------------------------------------------------

  /** Saving twice for one item gives one row. */
  async saveShopping(i: {
    captureItemId: string;
    captureId: string;
    title: string;
    note: string;
    quantity: string;
  }): Promise<string> {
    const { rows } = await this.pool.query(
      `insert into shopping_items (capture_item_id, capture_id, title, note, quantity)
       values ($1,$2,$3,$4,$5)
       on conflict (capture_item_id) do update set capture_item_id = excluded.capture_item_id
       returning id`,
      [i.captureItemId, i.captureId, i.title, i.note, i.quantity],
    );
    return rows[0].id as string;
  }

  async listShopping(): Promise<ShoppingRow[]> {
    const { rows } = await this.pool.query(
      `select * from shopping_items order by done, created_at desc, id`,
    );
    return rows.map(toShopping);
  }

  async setShoppingDone(id: string, done: boolean): Promise<ShoppingRow | null> {
    const { rows } = await this.pool.query(
      `update shopping_items set done=$2, done_at = case when $2 then now() else null end
        where id=$1 returning *`,
      [id, done],
    );
    return rows[0] ? toShopping(rows[0]) : null;
  }
}

export { HttpError };
