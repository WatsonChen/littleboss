import type { AgentId } from '@littleboss/shared';
import type { Pool } from '../db/pool.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { createProviders } from '../discussion/providers/index.js';
import { Roster } from '../discussion/roster.js';
import { InlineRunEngine } from '../runs/engine.js';
import { DemoCalendar, InAppCalendar, type CalendarClient } from './calendar.js';
import { InngestCaptureEngine } from './engine.js';
import { CaptureRepository } from './repository.js';
import { CaptureService, type CaptureEngine } from './service.js';

type Env = Record<string, string | undefined>;

export function createCaptureEngine(env: Env): CaptureEngine {
  const mode = env.LB_DISPATCH ?? (env.INNGEST_EVENT_KEY || env.INNGEST_DEV ? 'inngest' : 'inline');
  return mode === 'inngest' ? new InngestCaptureEngine() : new InlineRunEngine();
}

/** Demo mode writes to a demo table; otherwise events are kept in little boss (see InAppCalendar). */
export function createCalendar(env: Env, pool: Pool): CalendarClient {
  return env.LB_FAKE_PROVIDERS === '1' ? new DemoCalendar(pool) : new InAppCalendar();
}

export function createCaptureService(env: Env, pool: Pool): CaptureService {
  const roster = new Roster(env);
  const pricing = createPricing(env);
  const gateway = new ModelGateway(roster, createProviders(env), pricing);
  const budgetUsd = Number(env.LB_CAPTURE_DAILY_BUDGET_USD ?? '1');
  const agent = ['claude', 'gpt', 'gemini'].includes(env.LB_CAPTURE_AGENT ?? '')
    ? (env.LB_CAPTURE_AGENT as AgentId)
    : undefined;
  return new CaptureService({
    repo: new CaptureRepository(pool),
    roster,
    gateway,
    pricing,
    calendar: createCalendar(env, pool),
    engine: createCaptureEngine(env),
    config: {
      timeZone: env.LB_TIMEZONE || 'Asia/Taipei',
      dailyBudgetMicro: Math.round((Number.isFinite(budgetUsd) ? budgetUsd : 1) * 1_000_000),
      agent,
    },
    log: (msg, err) => console.error(msg, err),
  });
}

export { CaptureService } from './service.js';
