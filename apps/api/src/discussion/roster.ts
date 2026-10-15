import type { AgentId, AgentInfo } from '@littleboss/shared';

export type ProviderId = 'anthropic' | 'openai' | 'google';

interface AgentDef {
  id: AgentId;
  displayName: string;
  provider: ProviderId;
  keyEnv: string;
  modelEnv: string;
  defaultModel: string;
}

/**
 * The AI employees. A model name here is a default: override it per environment with
 * LB_MODEL_CLAUDE / LB_MODEL_GPT / LB_MODEL_GEMINI without a code change.
 */
const DEFS: AgentDef[] = [
  {
    id: 'claude',
    displayName: 'Claude',
    provider: 'anthropic',
    keyEnv: 'ANTHROPIC_API_KEY',
    modelEnv: 'LB_MODEL_CLAUDE',
    defaultModel: 'claude-sonnet-5-5',
  },
  {
    id: 'gpt',
    displayName: 'GPT',
    provider: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    modelEnv: 'LB_MODEL_GPT',
    defaultModel: 'gpt-5.6-sol',
  },
  {
    id: 'gemini',
    displayName: 'Gemini',
    provider: 'google',
    keyEnv: 'GEMINI_API_KEY',
    modelEnv: 'LB_MODEL_GEMINI',
    defaultModel: 'gemini-3.8-flash',
  },
];

/** Where an API key comes from. M1 reads server env vars; a per-user key store can replace this. */
export type KeySource = (def: { id: AgentId; provider: ProviderId }) => string | undefined;

export interface ResolvedAgent extends AgentInfo {
  providerId: ProviderId;
  /** Never leaves the server. */
  apiKey: string | undefined;
}

export class Roster {
  constructor(
    private readonly env: Record<string, string | undefined>,
    private readonly keySource?: KeySource,
  ) {}

  private resolve(def: AgentDef): ResolvedAgent {
    const fake = this.env.LB_FAKE_PROVIDERS === '1';
    const apiKey = fake
      ? 'fake'
      : (this.keySource?.(def) ?? this.env[def.keyEnv]?.trim()) || undefined;
    return {
      id: def.id,
      displayName: def.displayName,
      provider: fake ? 'fake' : def.provider,
      providerId: def.provider,
      model: fake ? 'fake' : this.env[def.modelEnv]?.trim() || def.defaultModel,
      hired: Boolean(apiKey),
      apiKey,
    };
  }

  get(id: AgentId): ResolvedAgent {
    return this.resolve(DEFS.find((d) => d.id === id)!);
  }

  /** What the client may see: no keys. */
  list(): AgentInfo[] {
    return DEFS.map((d) => {
      const r = this.resolve(d);
      return {
        id: r.id,
        displayName: r.displayName,
        provider: r.provider,
        model: r.model,
        hired: r.hired,
      };
    });
  }
}
