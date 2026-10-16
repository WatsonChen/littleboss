import type { Pool } from '../db/pool.js';
import { PgApprovalRepository } from '../db/pg-approval-repository.js';
import { ApprovalService } from '../core/approval.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { createProviders } from '../discussion/providers/index.js';
import { Roster } from '../discussion/roster.js';
import { InlineRunEngine, InngestRunEngine } from './engine.js';
import { RunDriver } from './driver.js';
import { RunRepository } from './repository.js';
import { RunService, type RunEngine } from './service.js';

type Env = Record<string, string | undefined>;

export function createRunEngine(env: Env): RunEngine {
  const mode = env.LB_DISPATCH ?? (env.INNGEST_EVENT_KEY || env.INNGEST_DEV ? 'inngest' : 'inline');
  return mode === 'inngest' ? new InngestRunEngine() : new InlineRunEngine();
}

export function createRunService(env: Env, pool: Pool): RunService {
  const repo = new RunRepository(pool);
  const roster = new Roster(env);
  const pricing = createPricing(env);
  const gateway = new ModelGateway(roster, createProviders(env), pricing);
  const approvals = new ApprovalService(new PgApprovalRepository(pool));
  return new RunService({
    repo,
    roster,
    gateway,
    pricing,
    approvals,
    driver: new RunDriver({ repo, gateway, approvals }),
    engine: createRunEngine(env),
    log: (msg, err) => console.error(msg, err),
  });
}

export { RunService } from './service.js';
