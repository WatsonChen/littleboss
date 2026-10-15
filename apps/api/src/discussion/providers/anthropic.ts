import { num, postJson, type FetchLike } from './http.js';
import type { Finish, ModelProvider } from './types.js';

export class AnthropicProvider implements ModelProvider {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.anthropic.com',
  ) {}

  async call(req: Parameters<ModelProvider['call']>[0]) {
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/messages`,
      { 'x-api-key': req.apiKey, 'anthropic-version': '2023-06-01' },
      {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
      },
      req,
    )) as {
      content?: { type?: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    const text = (json.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('');
    let finish: Finish = 'complete';
    if (json.stop_reason === 'max_tokens') finish = 'truncated';
    else if (json.stop_reason === 'refusal') finish = 'refused';
    else if (!text.trim()) finish = 'empty';
    return {
      text,
      finish,
      usage: json.usage
        ? { inputTokens: num(json.usage.input_tokens), outputTokens: num(json.usage.output_tokens) }
        : null,
    };
  }
}
