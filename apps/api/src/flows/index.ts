import type { AgentId } from '@littleboss/shared';
import type { Pool } from '../db/pool.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { createProviders } from '../discussion/providers/index.js';
import { Roster } from '../discussion/roster.js';
import { FlowRepository } from './repository.js';
import { FlowService } from './service.js';

type Env = Record<string, string | undefined>;

export function createFlowService(env: Env, pool: Pool): FlowService {
  const roster = new Roster(env);
  const pricing = createPricing(env);
  const gateway = new ModelGateway(roster, createProviders(env), pricing);
  const budgetUsd = Number(env.LB_FLOW_DAILY_BUDGET_USD ?? '1');
  const agent = ['claude', 'gpt', 'gemini'].includes(env.LB_FLOW_AGENT ?? '')
    ? (env.LB_FLOW_AGENT as AgentId)
    : undefined;
  const time = /^\d{2}:\d{2}$/.test(env.LB_PODCAST_PUBLISH_TIME ?? '')
    ? env.LB_PODCAST_PUBLISH_TIME!
    : '18:00';
  return new FlowService({
    repo: new FlowRepository(pool),
    roster,
    gateway,
    pricing,
    config: {
      timeZone: env.LB_TIMEZONE || 'Asia/Taipei',
      defaultTime: time,
      dailyBudgetMicro: Math.round((Number.isFinite(budgetUsd) ? budgetUsd : 1) * 1_000_000),
      agent,
    },
    log: (msg, err) => console.error(msg, err),
  });
}

export { FlowService } from './service.js';
