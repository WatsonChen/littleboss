import type { AgentId } from '@littleboss/shared';
import type { Pricing } from './pricing.js';
import { ProviderError, type ProviderSet } from './providers/index.js';
import type { Roster } from './roster.js';

export type GatewayResult =
  | { status: 'ok'; text: string; usage: Usage | null; costMicro: number | null }
  | {
      status: 'bad';
      reason: 'truncated' | 'refused' | 'empty';
      text: string;
      usage: Usage | null;
      costMicro: number | null;
    }
  | { status: 'failed'; code: string; reason: string };

interface Usage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * One model call outside the discussion room (used by runs). Answers that retrying cannot fix come
 * back as values; trouble that may pass (timeout, network, rate limit, provider 5xx) is thrown as
 * ProviderError so the engine's retry policy decides.
 */
export class ModelGateway {
  constructor(
    private readonly roster: Roster,
    private readonly providers: ProviderSet,
    private readonly pricing: Pricing,
    private readonly timeoutMs = 120_000,
  ) {}

  estimateCostMicro(agentId: AgentId, text: string): number {
    const input = this.pricing.estimateInputTokens(text);
    return this.pricing.estimateCostMicro(agentId, input, this.pricing.maxOutputTokens);
  }

  async complete(
    agentId: AgentId,
    prompt: { system: string; user: string },
  ): Promise<GatewayResult> {
    const agent = this.roster.get(agentId);
    if (!agent.hired || !agent.apiKey) {
      return { status: 'failed', code: 'agent_not_hired', reason: `${agent.displayName} is not set up.` };
    }
    let r;
    try {
      r = await this.providers[agent.providerId].call({
        model: agent.model,
        apiKey: agent.apiKey,
        system: prompt.system,
        user: prompt.user,
        maxOutputTokens: this.pricing.maxOutputTokens,
        timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'http') {
        if (err.status === 401 || err.status === 403) {
          return { status: 'failed', code: 'auth_failed', reason: err.message };
        }
        if (err.status !== undefined && err.status >= 400 && err.status < 500 && err.status !== 429 && err.status !== 408) {
          return { status: 'failed', code: 'provider_rejected', reason: err.message };
        }
      }
      throw err;
    }
    const costMicro = r.usage ? this.pricing.actualCostMicro(agentId, r.usage) : null;
    if (r.finish === 'complete') return { status: 'ok', text: r.text, usage: r.usage, costMicro };
    return { status: 'bad', reason: r.finish, text: r.text, usage: r.usage, costMicro };
  }
}
