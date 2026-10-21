import { createKit, type Kit } from '../discussion/test-kit.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { Roster } from '../discussion/roster.js';
import { FlowRepository } from './repository.js';
import { FlowService, type FlowServiceConfig } from './service.js';

export interface FlowKit extends Kit {
  flows: FlowService;
  repo: FlowRepository;
}

type Behaviour = NonNullable<Parameters<typeof createKit>[0]>;

/** 2026-10-21 (Wednesday) 14:00 in Taipei. */
export const NOW = new Date('2026-10-21T06:00:00Z');

export const draftJson = (n = 3) =>
  JSON.stringify({
    options: Array.from({ length: n }, (_, i) => ({
      title: `標題${i + 1}`,
      description: `描述${i + 1}`,
    })),
  });

export async function createFlowKit(
  behaviour: Behaviour = {},
  config: Partial<FlowServiceConfig> = {},
): Promise<FlowKit> {
  const kit = await createKit(behaviour);
  await kit.pool.query('truncate flows cascade');
  const roster = new Roster({ ANTHROPIC_API_KEY: 'test-a', OPENAI_API_KEY: 'test-o' });
  const pricing = createPricing({});
  const gateway = new ModelGateway(roster, kit.providers, pricing);
  const repo = new FlowRepository(kit.pool);
  const flows = new FlowService({
    repo,
    roster,
    gateway,
    pricing,
    clock: () => NOW,
    config: { retryDelayMs: 0, ...config },
  });
  return { ...kit, flows, repo };
}

let n = 0;
export const fid = () => `flow-req-${Date.now()}-${n++}`;
