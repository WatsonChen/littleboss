import type { AgentId } from '@littleboss/shared';

/**
 * Prices are USD per million tokens, which is numerically the same as micro-USD per token.
 * These defaults are PLACEHOLDERS to be checked against each provider's price page; override per
 * environment with LB_PRICE_<AGENT>_IN / LB_PRICE_<AGENT>_OUT. Every cost shown in M1 is an estimate.
 */
const DEFAULT_PRICE: Record<AgentId, { in: number; out: number }> = {
  claude: { in: 3, out: 15 },
  gpt: { in: 2.5, out: 15 },
  gemini: { in: 0.3, out: 2.5 },
};

export const DEFAULT_MAX_OUTPUT_TOKENS = 2048;

export interface Pricing {
  maxOutputTokens: number;
  estimateInputTokens(text: string): number;
  estimateCostMicro(agent: AgentId, inputTokens: number, outputTokens: number): number;
  actualCostMicro(agent: AgentId, usage: { inputTokens: number; outputTokens: number }): number;
}

export function createPricing(env: Record<string, string | undefined> = process.env): Pricing {
  const num = (v: string | undefined, fallback: number) => {
    const n = v === undefined || v === '' ? NaN : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  };
  const price = (agent: AgentId) => {
    const key = agent.toUpperCase();
    return {
      in: num(env[`LB_PRICE_${key}_IN`], DEFAULT_PRICE[agent].in),
      out: num(env[`LB_PRICE_${key}_OUT`], DEFAULT_PRICE[agent].out),
    };
  };
  const cost = (agent: AgentId, i: number, o: number) => {
    const p = price(agent);
    return Math.ceil(i * p.in + o * p.out);
  };
  return {
    maxOutputTokens: Math.max(
      1,
      Math.floor(num(env.LB_MAX_OUTPUT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS)),
    ),
    // Two characters per token errs on the high side for English and is close for Chinese,
    // so the estimate leans towards "costs more than it will".
    estimateInputTokens: (text) => Math.ceil(text.length / 2),
    estimateCostMicro: cost,
    actualCostMicro: (agent, u) => cost(agent, u.inputTokens, u.outputTokens),
  };
}
