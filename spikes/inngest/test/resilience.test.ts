import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CalendarWriteInput } from '../../../apps/api/src/core/flow';
import { InngestHarnessFactory } from './harness';

/**
 * The protection layer around Inngest, for what the contract cannot cover: the engine ends a run
 * and our own records still say it is alive. Without protection such a run stays "running" forever.
 *
 * - onFailure covers failures the flow code did not catch while the app can still be reached.
 * - reconcile covers the rest, above all the app being down while a wait timer fired and every
 *   retry was used up (the engine then also fails to run the onFailure handler, and does not
 *   try it again).
 */

const factory = new InngestHarnessFactory();
beforeAll(() => factory.setup(), 120_000);
afterAll(() => factory.teardown());

const input: CalendarWriteInput = { title: '買蛋糕', startsAt: '2026-10-16T15:30:00+08:00' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined | false>,
  timeoutMs: number,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await read();
    if (v) return v;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function rowOf(suffix: string) {
  const { rows } = await factory.db.query(
    `select run_id, state, outcome, engine_event_id, step_executions
       from spike_run_view where run_id like $1`,
    [`%-${suffix}`],
  );
  return rows[0] as
    | {
        run_id: string;
        state: string;
        outcome: { status: string; reason?: string } | null;
        engine_event_id: string | null;
        step_executions: Record<string, number>;
      }
    | undefined;
}

/** Start a run that waits for approval, then take the app away until the engine gives up on it. */
async function runLostWhileAppDown(name: string) {
  await factory.restartServerWith({ SPIKE_WAIT_TIMEOUT: '2s' });
  const h = factory.make();
  await h.startRun(name, input);
  expect((await h.getRun(name)).state).toBe('waiting_approval');
  const eventId = (await rowOf(name))!.engine_event_id!;
  expect(eventId).toBeTruthy();

  await factory.killServer();
  // The wait timer fires with nobody home; the attempts fail until the engine stops trying.
  await waitFor(
    'the engine to end the run as Failed',
    async () => (await factory.engineStatuses(eventId)).includes('Failed'),
    150_000,
  );
  // Give the engine time to also give up on the onFailure handler before the app comes back.
  await sleep(8000);
  return h;
}

describe('first line of defence: onFailure', () => {
  it('closes a run whose last step keeps failing, as unknown because the write already happened', async () => {
    await factory.restartServerWith({});
    const h = factory.make();
    await h.startRun('a', input);
    await factory.inject('failFinish', 3); // every attempt (1 + 2 retries) at the final step
    await h.submitApproval('a', 'approved');

    const row = await waitFor(
      'onFailure to close the run',
      async () => {
        const r = await rowOf('a');
        return r && r.state !== 'running' && r.state !== 'waiting_approval' ? r : false;
      },
      60_000,
    );
    expect(row.state).toBe('unknown');
    expect(row.outcome?.reason).toContain('the engine gave up');
    expect(h.external.effects).toBe(1); // the calendar entry exists; we only lost the verdict
  });
});

describe('second line of defence: reconcile', () => {
  it('closes a run the engine gave up on while the app was down', async () => {
    const h = await runLostWhileAppDown('b');
    await factory.startServer();
    await sleep(4000);
    // onFailure could not run while the app was down: our records still say the run is alive.
    expect(['running', 'waiting_approval']).toContain((await h.getRun('b')).state);

    const actions = await factory.reconcile(0);
    const row = (await rowOf('b'))!;
    expect(actions).toContainEqual(expect.objectContaining({ runId: row.run_id }));
    expect(row.state).toBe('failed');
    expect(row.outcome?.reason).toContain('the engine ended the run');
    expect(h.external.writeCalls).toBe(0);

    // A second pass has nothing left to do for it.
    expect((await factory.reconcile(0)).some((a) => a.runId === row.run_id)).toBe(false);
  });

  it('leaves a healthy waiting run alone, and the run still completes afterwards', async () => {
    await factory.restartServerWith({});
    const h = factory.make();
    await h.startRun('c', input);
    expect((await h.getRun('c')).state).toBe('waiting_approval');

    const actions = await factory.reconcile(0);
    const row = (await rowOf('c'))!;
    expect(actions).toContainEqual({ runId: row.run_id, action: 'still_running' });
    expect((await h.getRun('c')).state).toBe('waiting_approval');

    await h.submitApproval('c', 'approved');
    const done = await h.getRun('c');
    expect(done.state).toBe('succeeded');
    expect(h.external.effects).toBe(1);
  });

  it('does not look at runs younger than the grace period', async () => {
    await factory.restartServerWith({});
    const h = factory.make();
    await h.startRun('d', input);
    const row = (await rowOf('d'))!;
    const actions = await factory.reconcile(60_000);
    expect(actions.some((a) => a.runId === row.run_id)).toBe(false);
    expect((await h.getRun('d')).state).toBe('waiting_approval');
  });

  it('closes a run whose start event never reached the engine', async () => {
    await factory.restartServerWith({});
    await factory.db.query(
      `insert into spike_run_view (run_id, state, config) values ('orphan-1','running','{}')`,
    );
    const actions = await factory.reconcile(0);
    expect(actions).toContainEqual(
      expect.objectContaining({ runId: 'orphan-1', action: 'marked_failed' }),
    );
    const { rows } = await factory.db.query(
      `select state, outcome from spike_run_view where run_id='orphan-1'`,
    );
    expect(rows[0].state).toBe('failed');
  });

  it('reports "unknown", not "failed", when the external write had been attempted', async () => {
    await factory.restartServerWith({});
    await factory.db.query(
      `insert into spike_run_view (run_id, state, config, step_executions)
       values ('orphan-2','running','{}','{"write-calendar":1}')`,
    );
    await factory.reconcile(0);
    const { rows } = await factory.db.query(
      `select state, outcome from spike_run_view where run_id='orphan-2'`,
    );
    expect(rows[0].state).toBe('unknown');
    expect(rows[0].outcome.status).toBe('unknown');
  });

  it('does not close anything when the engine cannot be asked', async () => {
    await factory.restartServerWith({ INNGEST_REST_URL: 'http://127.0.0.1:9' });
    await factory.db.query(
      `insert into spike_run_view (run_id, state, config, engine_event_id)
       values ('orphan-3','running','{}','01ABCDEFGHJKMNPQRSTVWXYZ00')`,
    );
    const actions = await factory.reconcile(0);
    expect(actions).toContainEqual(
      expect.objectContaining({ runId: 'orphan-3', action: 'skipped_error' }),
    );
    const { rows } = await factory.db.query(
      `select state from spike_run_view where run_id='orphan-3'`,
    );
    expect(rows[0].state).toBe('running');
  });
});
