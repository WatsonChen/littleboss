import { createPool, type Pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { InlineDispatcher } from './dispatcher.js';
import { createPricing } from './pricing.js';
import { FakeProvider, type FakeBehaviour } from './providers/index.js';
import { DiscussionRepository } from './repository.js';
import { Roster } from './roster.js';
import { DiscussionService, type ServiceConfig } from './service.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

export interface Kit {
  pool: Pool;
  service: DiscussionService;
  dispatcher: InlineDispatcher;
  providers: { anthropic: FakeProvider; openai: FakeProvider; google: FakeProvider };
}

/** A service on the real test database with scripted fake models. Gemini is left "not hired". */
export async function createKit(
  behaviour: { anthropic?: FakeBehaviour; openai?: FakeBehaviour } = {},
  config: Partial<ServiceConfig> = {},
  env: Record<string, string | undefined> = {},
): Promise<Kit> {
  const pool = createPool(TEST_DATABASE_URL!, 20);
  await migrate(pool);
  const providers = {
    anthropic: new FakeProvider(behaviour.anthropic),
    openai: new FakeProvider(behaviour.openai),
    google: new FakeProvider(),
  };
  const dispatcher = new InlineDispatcher();
  const service = new DiscussionService({
    repo: new DiscussionRepository(pool),
    roster: new Roster({ ANTHROPIC_API_KEY: 'test-a', OPENAI_API_KEY: 'test-o', ...env }),
    providers,
    dispatcher,
    pricing: createPricing({}),
    config,
  });
  return { pool, service, dispatcher, providers };
}

export async function resetDiscussionTables(pool: Pool) {
  await pool.query('truncate threads cascade');
}
