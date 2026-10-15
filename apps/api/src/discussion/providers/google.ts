import { num, postJson, type FetchLike } from './http.js';
import type { Finish, ModelProvider } from './types.js';

export class GoogleProvider implements ModelProvider {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly baseUrl = 'https://generativelanguage.googleapis.com',
  ) {}

  async call(req: Parameters<ModelProvider['call']>[0]) {
    const json = (await postJson(
      this.fetchImpl,
      `${this.baseUrl}/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
      { 'x-goog-api-key': req.apiKey },
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        generationConfig: { maxOutputTokens: req.maxOutputTokens },
      },
      req,
    )) as {
      candidates?: {
        content?: { parts?: { text?: string; thought?: boolean }[] };
        finishReason?: string;
      }[];
      promptFeedback?: { blockReason?: string };
      usageMetadata?: {
        promptTokenCount?: unknown;
        candidatesTokenCount?: unknown;
        thoughtsTokenCount?: unknown;
      };
    };
    const cand = json.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => !p.thought)
      .map((p) => p.text ?? '')
      .join('');
    let finish: Finish = 'complete';
    if (json.promptFeedback?.blockReason) finish = 'refused';
    else if (cand?.finishReason === 'MAX_TOKENS') finish = 'truncated';
    else if (
      cand?.finishReason &&
      !['STOP', 'FINISH_REASON_UNSPECIFIED'].includes(cand.finishReason)
    )
      finish = 'refused';
    else if (!text.trim()) finish = 'empty';
    const u = json.usageMetadata;
    return {
      text,
      finish,
      // Thinking tokens are billed as output.
      usage: u
        ? {
            inputTokens: num(u.promptTokenCount),
            outputTokens: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount),
          }
        : null,
    };
  }
}
