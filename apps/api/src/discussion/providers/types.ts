export interface ProviderRequest {
  model: string;
  apiKey: string;
  system: string;
  user: string;
  maxOutputTokens: number;
  timeoutMs: number;
}

export type Finish = 'complete' | 'truncated' | 'refused' | 'empty';

export interface ProviderResult {
  text: string;
  finish: Finish;
  usage: { inputTokens: number; outputTokens: number } | null;
}

export interface ModelProvider {
  call(req: ProviderRequest): Promise<ProviderResult>;
}

/** The provider could not give an answer at all (as opposed to giving a bad one). */
export class ProviderError extends Error {
  constructor(
    readonly kind: 'timeout' | 'network' | 'http',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
