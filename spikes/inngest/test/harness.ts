import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import pg from 'pg';
import { ApprovalService } from '../../../apps/api/src/core/approval';
import { ExternalAmbiguousError, ExternalRejectedError } from '../../../apps/api/src/core/errors';
import type { EngineHarness } from '../../../apps/api/src/core/engine-contract';
import { FakeExternalService } from '../../../apps/api/src/core/fake-external';
import {
  APPROVAL_STEP,
  type CalendarWriteInput,
  type RunConfig,
} from '../../../apps/api/src/core/flow';
import { proposalHashFor } from '../../../apps/api/src/core/proposal';
import { PgApprovalRepository } from '../../../apps/api/src/db/pg-approval-repository';
import type { RunView } from '../../../apps/api/src/core/reference-engine';

export const DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://littleboss:littleboss_dev@127.0.0.1:5432/littleboss_test';
const SERVER_PORT = 3427;
const EXTERNAL_PORT = 3428;
const INNGEST_PORT = 8288;
const TERMINAL = new Set([
  'succeeded',
  'rejected',
  'needs_reapproval',
  'failed',
  'unknown',
  'cancelled',
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Inngest dev server: stands in for the hosted service and outlives our app restarts. */
async function startInngestDevServer(): Promise<ChildProcess> {
  const child = spawn(
    'node_modules/.bin/inngest-cli',
    [
      'dev',
      '--no-discovery',
      '--no-poll',
      '-u',
      `http://127.0.0.1:${SERVER_PORT}/api/inngest`,
      '--port',
      String(INNGEST_PORT),
      '--retry-interval',
      '1',
    ],
    { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout?.on('data', (d) => process.env.SPIKE_LOG && process.stdout.write(`[inn] ${d}`));
  child.stderr?.on('data', (d) => process.env.SPIKE_LOG && process.stdout.write(`[inn!] ${d}`));
  for (let i = 0; i < 300; i += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${INNGEST_PORT}/health`)).ok) return child;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('inngest dev server did not start');
}

/** The server process under test: our Fastify app serving the Inngest functions. */
class ServerProcess {
  private child: ChildProcess | undefined;
  private exited = true;

  get alive(): boolean {
    const c = this.child;
    // exit events can arrive after the socket already closed, so also read the process state
    return !this.exited && !!c && c.exitCode === null && c.signalCode === null;
  }

  /** Extra environment for the next start (the test can change it between restarts). */
  env: Record<string, string> = {};

  async start(): Promise<void> {
    if (this.alive) return;
    this.exited = false;
    this.child = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        DATABASE_URL,
        EXTERNAL_URL: `http://127.0.0.1:${EXTERNAL_PORT}`,
        INNGEST_BASE_URL: `http://127.0.0.1:${INNGEST_PORT}`,
        INNGEST_DEV: '1',
        SPIKE_WAIT_TIMEOUT: process.env.SPIKE_WAIT_TIMEOUT ?? '1h',
        ...this.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child.stdout?.on(
      'data',
      (d) => process.env.SPIKE_LOG && process.stdout.write(`[srv] ${d}`),
    );
    this.child.stderr?.on(
      'data',
      (d) => process.env.SPIKE_LOG && process.stdout.write(`[srv!] ${d}`),
    );
    this.child.on('exit', (code, signal) => {
      if (process.env.SPIKE_LOG)
        process.stdout.write(`[srv] exited code=${code} signal=${signal}\n`);
      this.exited = true;
    });
    for (let i = 0; i < 100; i += 1) {
      if (this.exited) throw new Error('server exited during start');
      try {
        const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/health`);
        if (res.ok) return;
      } catch {
        /* not up yet */
      }
      await sleep(100);
    }
    throw new Error('server did not become healthy');
  }

  async kill(): Promise<void> {
    if (!this.child || this.exited) return;
    this.child.kill('SIGKILL');
    for (let i = 0; i < 50 && !this.exited; i += 1) await sleep(20);
  }
}

/** Hosts the fake external service over HTTP so it outlives server restarts. */
function hostExternal(getExternal: () => FakeExternalService): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const body = await new Promise<string>((resolve) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
    });
    const external = getExternal();
    try {
      if (url.pathname === '/write') {
        const { idempotencyKey, payload } = JSON.parse(body);
        res.end(JSON.stringify(await external.write(idempotencyKey, payload)));
      } else if (url.pathname === '/lookup') {
        const found = await external.lookup(url.searchParams.get('key') ?? '');
        res.statusCode = found ? 200 : 404;
        res.end(JSON.stringify(found));
      }
    } catch (err) {
      res.statusCode =
        err instanceof ExternalRejectedError
          ? 422
          : err instanceof ExternalAmbiguousError
            ? 504
            : 500;
      res.end(String(err));
    }
  });
}

/** One harness per contract test. Shares one server, one database and one HTTP fake. */
export class InngestHarnessFactory {
  private pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  private approvals = new ApprovalService(new PgApprovalRepository(this.pool));
  private server = new ServerProcess();
  private inngestDev: ChildProcess | undefined;
  private externalHttp: Server | undefined;
  private current: { external: FakeExternalService } | undefined;
  private counter = 0;

  async setup(): Promise<void> {
    await this.pool.query(
      await (
        await import('node:fs/promises')
      ).readFile(new URL('../sql/spike.sql', import.meta.url), 'utf8'),
    );
    await this.pool.query('truncate approvals, spike_run_view');
    this.externalHttp = hostExternal(() => this.current!.external);
    await new Promise<void>((r) => this.externalHttp!.listen(EXTERNAL_PORT, '127.0.0.1', r));
    await this.server.start();
    this.inngestDev = await startInngestDevServer();
    await this.syncApp();
  }

  /** Restart the app with different settings, and register it again (a deploy does both). */
  async restartServerWith(env: Record<string, string>): Promise<void> {
    await this.server.kill();
    this.server.env = env;
    await this.server.start();
    await this.syncApp();
  }
  async killServer(): Promise<void> {
    await this.server.kill();
  }
  async startServer(): Promise<void> {
    await this.server.start();
  }
  /** Runs one reconcile pass inside the app and returns what it did. */
  async reconcile(olderThanMs: number): Promise<{ runId: string; action: string }[]> {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/reconcile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ olderThanMs }),
    });
    return (await res.json()) as { runId: string; action: string }[];
  }
  /** Direct database access for assertions about our own records. */
  get db(): pg.Pool {
    return this.pool;
  }
  /** The engine's own statuses for the runs of one start event (read through its REST API). */
  async engineStatuses(engineEventId: string): Promise<string[]> {
    const base = `http://127.0.0.1:${INNGEST_PORT}`;
    const list = (await (await fetch(`${base}/v1/events/${engineEventId}/runs`)).json()) as {
      data?: { run_id: string }[] | null;
    };
    const out: string[] = [];
    for (const r of list.data ?? []) {
      const run = (await (await fetch(`${base}/v1/runs/${r.run_id}`)).json()) as {
        data: { status: string };
      };
      out.push(run.data.status);
    }
    return out;
  }
  /** Send a fault to the app (the same routes the contract's `inject` uses). */
  async inject(kind: string, times = 1): Promise<void> {
    await fetch(`http://127.0.0.1:${SERVER_PORT}/api/inject`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, step: 'finish', times }),
    });
  }

  /** Tell the dev server where our app is (the same registration a deploy performs). */
  private async syncApp(): Promise<void> {
    const res = await fetch(`http://127.0.0.1:${SERVER_PORT}/api/inngest`, { method: 'PUT' });
    if (!res.ok) throw new Error(`app sync failed: ${res.status} ${await res.text()}`);
  }

  async teardown(): Promise<void> {
    await this.server.kill();
    this.inngestDev?.kill('SIGKILL');
    await new Promise((r) => this.externalHttp?.close(r));
    await this.pool.end();
  }

  /** Call this from beforeEach-like context via makeHarness. */
  make(): EngineHarness {
    const prefix = `t${(this.counter += 1)}-${Date.now().toString(36)}`;
    const external = new FakeExternalService();
    this.current = { external };
    const inputs = new Map<string, CalendarWriteInput>();
    const live: RunConfig = { roleVersion: 'v1', model: 'm1', maxRetries: 2 };
    const id = (runId: string) => `${prefix}-${runId}`;
    const server = this.server;
    const pool = this.pool;
    const approvals = this.approvals;
    const base = `http://127.0.0.1:${SERVER_PORT}`;

    // A server found dead mid-test is a simulated crash and stays down until restart().
    let crashed = false;
    const ensure = async () => {
      if (!server.alive && !crashed) await server.start();
    };

    const post = async (path: string, body: unknown): Promise<unknown> => {
      await ensure();
      try {
        const res = await fetch(base + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        return await res.json();
      } catch (err) {
        // A request that kills the server (an injected crash during an inline step) is a crash,
        // not a test error.
        await sleep(300);
        if (!server.alive) {
          crashed = true;
          return { crashed: true };
        }
        throw err;
      }
    };
    const readView = async (runId: string) => {
      const { rows } = await pool.query('select * from spike_run_view where run_id=$1', [
        id(runId),
      ]);
      return rows[0] as
        | {
            state: RunView['state'];
            outcome: RunView['outcome'] | null;
            completed_steps: string[];
            step_executions: Record<string, number>;
            config: RunConfig;
            updated_at: Date;
          }
        | undefined;
    };
    /** Wait until the run stops changing: terminal, waiting for approval, or the server died. */
    const settle = async (runId: string) => {
      let lastStamp = '';
      let stableSince = Date.now();
      const started = Date.now();
      while (Date.now() - started < 20_000) {
        const row = await readView(runId);
        const stamp = row ? `${row.state}|${row.updated_at.toISOString()}` : 'none';
        if (stamp !== lastStamp) {
          lastStamp = stamp;
          stableSince = Date.now();
        }
        const quietFor = Date.now() - stableSince;
        const resting = !row || TERMINAL.has(row.state) || row.state === 'waiting_approval';
        if (!server.alive && quietFor > 150) {
          crashed = true;
          return;
        }
        if (resting && quietFor > 600) return;
        if (!resting && quietFor > 8_000) return; // stuck in 'running'
        await sleep(50);
      }
    };

    return {
      external,
      async startRun(runId, input) {
        inputs.set(runId, input);
        await post('/api/start', { runId: id(runId), input, config: live });
        await settle(runId);
      },
      async submitApproval(runId, decision, hashOverride) {
        const input = inputs.get(runId);
        if (!input) throw new Error(`unknown run ${runId}`);
        const result = await approvals.submit({
          runId: id(runId),
          stepId: APPROVAL_STEP,
          proposalHash: hashOverride ?? proposalHashFor(input),
          decision,
        });
        if (server.alive) {
          try {
            await post('/api/wake', { runId: id(runId) });
          } catch {
            /* server died while waking: the decision is stored, restart will find it */
          }
        }
        await settle(runId);
        return result;
      },
      async restart() {
        await server.kill();
        crashed = false;
        await server.start();
        // Settle every run this harness started.
        for (const runId of inputs.keys()) await settle(runId);
      },
      async cancel(runId) {
        if (server.alive) await post('/api/cancel', { runId: id(runId) });
        await settle(runId);
      },
      async getRun(runId) {
        await ensure();
        const row = await readView(runId);
        if (!row) throw new Error(`unknown run ${runId}`);
        return {
          state: row.state,
          outcome: row.outcome ?? undefined,
          completedSteps: row.completed_steps,
          stepExecutions: row.step_executions,
          config: row.config,
        };
      },
      setLiveConfig(next) {
        Object.assign(live, next);
      },
      inject: {
        crashBefore: async (step) =>
          void (await post('/api/inject', { kind: 'crashBefore', step })),
        crashAfter: async (step) => void (await post('/api/inject', { kind: 'crashAfter', step })),
        failAttempts: async (step, times) =>
          void (await post('/api/inject', { kind: 'failAttempts', step, times })),
        cancelWhenStepStarts: async (step) =>
          void (await post('/api/inject', { kind: 'cancelWhenStepStarts', step })),
      },
    };
  }
}
