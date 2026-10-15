import type { ProviderId } from '../roster.js';
import { AnthropicProvider } from './anthropic.js';
import { FakeProvider } from './fake.js';
import { GoogleProvider } from './google.js';
import { OpenAIProvider } from './openai.js';
import type { ModelProvider } from './types.js';

export type ProviderSet = Record<ProviderId, ModelProvider>;

export function createProviders(
  env: Record<string, string | undefined> = process.env,
): ProviderSet {
  if (env.LB_FAKE_PROVIDERS === '1') {
    const fake = new FakeProvider();
    return { anthropic: fake, openai: fake, google: fake };
  }
  return {
    anthropic: new AnthropicProvider(),
    openai: new OpenAIProvider(),
    google: new GoogleProvider(),
  };
}

export * from './types.js';
export { FakeProvider, type FakeBehaviour } from './fake.js';
