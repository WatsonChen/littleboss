import { ApprovalService } from '../core/approval.js';
import { PgApprovalRepository } from '../db/pg-approval-repository.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { Roster } from '../discussion/roster.js';
import { createKit, type Kit } from '../discussion/test-kit.js';
import { InlineRunEngine } from './engine.js';
import { RunDriver } from './driver.js';
import { RunRepository } from './repository.js';
import { RunService, type RunEngine, type RunServiceConfig } from './service.js';

export interface RunKit extends Kit {
  runs: RunService;
  engine: InlineRunEngine;
  repo: RunRepository;
  approvals: ApprovalService;
  threadId: string;
  conclusion: { assetId: string; version: number };
  /** A second service over the same database, like a fresh process after a restart. */
  restart(): { runs: RunService; engine: InlineRunEngine };
}

type Behaviour = NonNullable<Parameters<typeof createKit>[0]>;

export const DRAFT_TEXT = '草稿：先做 A，再做 B';
export const FINAL_TEXT = '成品：A 與 B 都完成了';

/** Default model script: the first call (no <draft> in the prompt) drafts, the second revises. */
export const scripted: NonNullable<Behaviour['anthropic']> = (req) => ({
  text: req.user.includes('<draft>') ? FINAL_TEXT : DRAFT_TEXT,
  finish: 'complete',
  usage: { inputTokens: 100, outputTokens: 50 },
});

export function buildRuns(
  kit: Kit,
  opts: {
    config?: Partial<RunServiceConfig>;
    wrapEngine?: (e: InlineRunEngine) => RunEngine;
  } = {},
) {
  const env = { ANTHROPIC_API_KEY: 'test-a', OPENAI_API_KEY: 'test-o' };
  const roster = new Roster(env);
  const pricing = createPricing({});
  const gateway = new ModelGateway(roster, kit.providers, pricing);
  const repo = new RunRepository(kit.pool);
  const approvals = new ApprovalService(new PgApprovalRepository(kit.pool));
  const engine = new InlineRunEngine();
  const runs = new RunService({
    repo,
    roster,
    gateway,
    pricing,
    approvals,
    driver: new RunDriver({ repo, gateway, approvals, config: { retryDelayMs: 0 } }),
    engine: opts.wrapEngine ? opts.wrapEngine(engine) : engine,
    config: opts.config,
  });
  return { runs, engine, repo, approvals };
}

export async function createRunKit(
  behaviour: Behaviour = { anthropic: scripted },
  opts: Parameters<typeof buildRuns>[1] & { budgetMicro?: number } = {},
): Promise<RunKit> {
  const kit = await createKit(behaviour);
  await kit.pool.query('truncate threads cascade');
  await kit.pool.query('truncate runs cascade');
  await kit.pool.query('truncate approvals');
  const thread = await kit.service.createThread({
    title: 't',
    budgetLimitMicro: opts.budgetMicro ?? 5_000_000,
  });
  const saved = await kit.service.saveConclusion(thread.id, {
    title: '週末行程',
    content: '週六去爬山，週日休息。',
    sourceMessageIds: [],
  });
  const built = buildRuns(kit, opts);
  return {
    ...kit,
    ...built,
    threadId: thread.id,
    conclusion: { assetId: saved.assetId, version: saved.version },
    restart: () => {
      const b = buildRuns(kit, opts);
      return { runs: b.runs, engine: b.engine };
    },
  };
}

let n = 0;
export const rid = () => `run-req-${Date.now()}-${n++}`;
