import type { ModelProvider, ProviderRequest, ProviderResult } from './types.js';

export type FakeBehaviour = (req: ProviderRequest) => ProviderResult | Promise<ProviderResult>;

/**
 * Stands in for a real model: in tests (with scripted behaviour) and for trying the app without
 * keys (LB_FAKE_PROVIDERS=1). The default answer says plainly that it is not a real model.
 */
export class FakeProvider implements ModelProvider {
  readonly calls: ProviderRequest[] = [];
  constructor(private readonly behaviour?: FakeBehaviour) {}

  async call(req: ProviderRequest): Promise<ProviderResult> {
    this.calls.push(req);
    if (this.behaviour) return this.behaviour(req);
    const task = /<task>\n([\s\S]*?)\n<\/task>/.exec(req.user)?.[1] ?? '';
    return {
      text: `（示範回覆，不是真的 AI）收到：${task.slice(0, 120)}`,
      finish: 'complete',
      usage: { inputTokens: Math.ceil(req.user.length / 2), outputTokens: 40 },
    };
  }
}
