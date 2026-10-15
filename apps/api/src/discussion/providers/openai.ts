import { num, postJson, type FetchLike } from './http.js';
import type { Finish, ModelProvider } from './types.js';

export class OpenAIProvider implements ModelProvider {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://api.openai.com',
  ) {}

  async call(req: Parameters<ModelProvider['call']>[0]) {
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1/chat/completions`,
      { authorization: `Bearer ${req.apiKey}` },
      {
        model: req.model,
        max_completion_tokens: req.maxOutputTokens,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.user },
        ],
      },
      req,
    )) as {
      choices?: {
        message?: { content?: string | null; refusal?: string | null };
        finish_reason?: string;
      }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const choice = json.choices?.[0];
    const text = choice?.message?.content ?? '';
    let finish: Finish = 'complete';
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') finish = 'refused';
    else if (choice?.finish_reason === 'length') finish = 'truncated';
    else if (!text.trim()) finish = 'empty';
    return {
      text,
      finish,
      usage: json.usage
        ? {
            inputTokens: num(json.usage.prompt_tokens),
            outputTokens: num(json.usage.completion_tokens),
          }
        : null,
    };
  }
}
