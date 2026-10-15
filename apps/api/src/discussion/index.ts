import { createPool, type Pool } from '../db/pool.js';
import { InlineDispatcher, type Dispatcher } from './dispatcher.js';
import { InngestDispatcher } from './inngest.js';
import { createPricing } from './pricing.js';
import { createProviders } from './providers/index.js';
import { DiscussionRepository } from './repository.js';
import { Roster } from './roster.js';
import { DiscussionService, type ServiceConfig } from './service.js';

type Env = Record<string, string | undefined>;

function intEnv(env: Env, key: string): number | undefined {
  const v = env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
}

/** Picks how queued calls get run: Inngest where it is configured, in-process otherwise (local work). */
export function createDispatcher(env: Env): Dispatcher {
  const mode = env.LB_DISPATCH ?? (env.INNGEST_EVENT_KEY || env.INNGEST_DEV ? 'inngest' : 'inline');
  return mode === 'inngest' ? new InngestDispatcher() : new InlineDispatcher();
}

export function createDiscussionService(env: Env, pool: Pool): DiscussionService {
  const config: Partial<ServiceConfig> = {};
  const timeout = intEnv(env, 'LB_CALL_TIMEOUT_MS');
  if (timeout) config.callTimeoutMs = timeout;
  const budgetUsd = env.LB_DEFAULT_BUDGET_USD ? Number(env.LB_DEFAULT_BUDGET_USD) : NaN;
  if (Number.isFinite(budgetUsd) && budgetUsd >= 0)
    config.defaultBudgetMicro = Math.round(budgetUsd * 1e6);
  return new DiscussionService({
    repo: new DiscussionRepository(pool),
    roster: new Roster(env),
    providers: createProviders(env),
    dispatcher: createDispatcher(env),
    pricing: createPricing(env),
    config,
    log: (msg, err) => console.error(msg, err),
  });
}

export { createPool };
export { DiscussionService } from './service.js';
