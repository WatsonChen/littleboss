import pg from 'pg';
import { ApprovalService } from '../../../apps/api/src/core/approval';
import { PgApprovalRepository } from '../../../apps/api/src/db/pg-approval-repository';
import { ExternalAmbiguousError, ExternalRejectedError } from '../../../apps/api/src/core/errors';
import type { ExternalClient } from '../../../apps/api/src/core/external-action';
import type { FlowOutcome, RunConfig } from '../../../apps/api/src/core/flow';

/** Everything the engine's steps need, built lazily once per process. */
let pool: pg.Pool | undefined;
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  return pool;
}

export function approvals(): ApprovalService {
  return new ApprovalService(new PgApprovalRepository(db()));
}

/** The fake external service lives in the TEST process and is reached over HTTP, like a real API. */
export const externalClient: ExternalClient = {
  async write(idempotencyKey, payload) {
    const res = await fetch(`${process.env.EXTERNAL_URL}/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey, payload }),
    });
    if (res.status === 200) return (await res.json()) as { externalId: string };
    if (res.status === 422) throw new ExternalRejectedError(await res.text());
    throw new ExternalAmbiguousError(`status ${res.status}`);
  },
  async lookup(idempotencyKey) {
    const res = await fetch(
      `${process.env.EXTERNAL_URL}/lookup?key=${encodeURIComponent(idempotencyKey)}`,
    );
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`lookup status ${res.status}`);
    return (await res.json()) as { externalId: string };
  },
};

// ---- run view (what the harness reads) ------------------------------------------------------

export const view = {
  async create(runId: string, config: RunConfig): Promise<{ workflowRunId: string | null }> {
    await db().query(
      `insert into spike_run_view (run_id, state, config) values ($1, 'running', $2)
       on conflict (run_id) do nothing`,
      [runId, JSON.stringify(config)],
    );
    const { rows } = await db().query(
      'select workflow_run_id from spike_run_view where run_id=$1',
      [runId],
    );
    return { workflowRunId: rows[0]?.workflow_run_id ?? null };
  },
  async attachWorkflowRun(runId: string, workflowRunId: string) {
    await db().query(
      `update spike_run_view set workflow_run_id=$2, updated_at=clock_timestamp()
       where run_id=$1 and workflow_run_id is null`,
      [runId, workflowRunId],
    );
  },
  /** Only moves between active states, so a finished or cancelled run is never revived. */
  async setActiveState(runId: string, state: 'running' | 'waiting_approval') {
    await db().query(
      `update spike_run_view set state=$2, updated_at=clock_timestamp()
       where run_id=$1 and state in ('running','waiting_approval')`,
      [runId, state],
    );
  },
  async finish(runId: string, outcome: FlowOutcome) {
    await db().query(
      `update spike_run_view set state=$2, outcome=$3, updated_at=clock_timestamp()
       where run_id=$1 and state in ('running','waiting_approval')`,
      [runId, outcome.status, JSON.stringify(outcome)],
    );
  },
  async markCancelled(runId: string) {
    await db().query(
      `update spike_run_view set state='cancelled', updated_at=clock_timestamp()
       where run_id=$1 and state in ('running','waiting_approval')`,
      [runId],
    );
  },
  async bumpExecution(runId: string, step: string) {
    await db().query(
      `update spike_run_view
         set step_executions = jsonb_set(step_executions, array[$2::text],
               to_jsonb(coalesce((step_executions->>$2)::int, 0) + 1)),
             updated_at = clock_timestamp()
       where run_id=$1`,
      [runId, step],
    );
  },
  async markCompleted(runId: string, step: string) {
    await db().query(
      `update spike_run_view
         set completed_steps = case when completed_steps ? $2 then completed_steps
                                    else completed_steps || to_jsonb($2::text) end,
             updated_at = clock_timestamp()
       where run_id=$1`,
      [runId, step],
    );
  },
};

// ---- fault injection (set over HTTP by the test; lives in this process's memory) -------------

export const faults = {
  crashBefore: new Set<string>(),
  crashAfter: new Set<string>(),
  failAttempts: new Map<string, number>(),
  cancelWhenStepStarts: new Set<string>(),
};
