import { view } from './runtime';

/** What we need from the engine: the status of every run that one start event produced. */
export interface EngineRuns {
  runStatusesForEvent(engineEventId: string): Promise<string[]>;
}

/** Inngest REST API. Hosted needs `INNGEST_SIGNING_KEY`; the dev server needs nothing. */
export function inngestRestClient(): EngineRuns {
  const base =
    process.env.INNGEST_REST_URL ?? process.env.INNGEST_BASE_URL ?? 'http://127.0.0.1:8288';
  const key = process.env.INNGEST_SIGNING_KEY;
  const get = async (path: string) => {
    const res = await fetch(`${base}${path}`, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
    });
    if (!res.ok) throw new Error(`inngest lookup ${path} failed: ${res.status}`);
    return (await res.json()) as { data?: unknown };
  };
  return {
    async runStatusesForEvent(engineEventId) {
      const list = (await get(`/v1/events/${encodeURIComponent(engineEventId)}/runs`)).data as
        { run_id: string }[] | null | undefined;
      // The per-event listing reports a run that is still waiting as "Completed", so it is only
      // used to find the run ids. The status of each run is read from the run itself.
      const statuses: string[] = [];
      for (const r of list ?? []) {
        const run = (await get(`/v1/runs/${encodeURIComponent(r.run_id)}`)).data as {
          status: string;
        };
        statuses.push(run.status);
      }
      return statuses;
    },
  };
}

export interface ReconcileAction {
  runId: string;
  action: 'still_running' | 'marked_failed' | 'marked_cancelled' | 'skipped_error';
  detail?: string;
}

/**
 * Second line of defence: the engine can fail a run without our code ever running (the app was
 * unreachable while a timer fired and every retry was used up). This compares our own record of
 * active runs with what the engine says and closes the ones the engine has already ended.
 *
 * It never decides anything about a run the engine still considers alive.
 */
export async function reconcileRuns(
  engine: EngineRuns,
  options: { olderThanMs: number } = { olderThanMs: 5 * 60_000 },
): Promise<ReconcileAction[]> {
  const actions: ReconcileAction[] = [];
  for (const run of await view.listToReconcile(options.olderThanMs)) {
    const runId = run.run_id;
    try {
      if (!run.engine_event_id) {
        // The record exists but the start event never reached the engine.
        await view.markEngineFailure(runId, 'the engine never received the start event');
        actions.push({ runId, action: 'marked_failed', detail: 'no engine event' });
        continue;
      }
      const statuses = await engine.runStatusesForEvent(run.engine_event_id);
      if (statuses.length === 0) {
        await view.markEngineFailure(runId, 'the engine has no run for this start event');
        actions.push({ runId, action: 'marked_failed', detail: 'engine has no run' });
        continue;
      }
      if (statuses.includes('Running') || statuses.includes('Queued')) {
        await view.touchReconciled(runId);
        actions.push({ runId, action: 'still_running' });
      } else if (statuses.includes('Cancelled')) {
        await view.markCancelled(runId);
        actions.push({ runId, action: 'marked_cancelled' });
      } else {
        // Failed, or Completed without our own "finish" step having recorded a result.
        await view.markEngineFailure(runId, `the engine ended the run as ${statuses.join(',')}`);
        actions.push({ runId, action: 'marked_failed', detail: statuses.join(',') });
      }
    } catch (err) {
      // An engine API hiccup must not close a run that may be fine: leave it for the next pass.
      actions.push({
        runId,
        action: 'skipped_error',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return actions;
}
