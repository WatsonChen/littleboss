import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
const SERVER_PORT = 3417;
const EXTERNAL_PORT = 3418;
const TERMINAL = new Set([
  'succeeded',
  'rejected',
  'needs_reapproval',
  'failed',
  'unknown',
  'cancelled',
]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The server process under test: the built Nitro app, with the SDK's local world on disk. */
class ServerProcess {
  private child: ChildProcess | undefined;
  private exited = true;
  constructor(private readonly dataDir: string) {}

  get alive(): boolean {
    const c = this.child;
    // exit events can arrive after the socket already closed, so also read the process state
    return !this.exited && !!c && c.exitCode === null && c.signalCode === null;
  }

  async start(): Promise<void> {
    if (this.alive) return;
    this.exited = false;
    this.child = spawn('node', ['.output/server/index.mjs'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: {
        ...process.env,
        PORT: String(SERVER_PORT),
        DATABASE_URL,
        // How long after a step starts another invocation assumes its owner may still be running
        // it. A crashed step is retried only after this lease; the default is 860s.
        WORKFLOW_INLINE_OWNERSHIP_LEASE_SECONDS: process.env.SPIKE_LEASE ?? '2',
        EXTERNAL_URL: `http://127.0.0.1:${EXTERNAL_PORT}`,
        ...(process.env.SPIKE_WORLD === 'local'
          ? {
              WORKFLOW_TARGET_WORLD: 'local',
              WORKFLOW_LOCAL_DATA_DIR: this.dataDir,
              WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${SERVER_PORT}`,
            }
          : {
              WORKFLOW_TARGET_WORLD: '@workflow/world-postgres',
              WORKFLOW_POSTGRES_URL: DATABASE_URL,
            }),
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
export class VercelWorkflowHarnessFactory {
  private pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
  private approvals = new ApprovalService(new PgApprovalRepository(this.pool));
  private dataDir = mkdtempSync(join(tmpdir(), 'wf-local-'));
  private server = new ServerProcess(this.dataDir);
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
  }

  async teardown(): Promise<void> {
    await this.server.kill();
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
