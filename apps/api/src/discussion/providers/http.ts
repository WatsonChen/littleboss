import { ProviderError, type ProviderRequest } from './types.js';

export type FetchLike = typeof fetch;

function redact(text: string, secret: string): string {
  return secret ? text.split(secret).join('[key]') : text;
}

/** POST JSON with a deadline. Failures become ProviderError with a message that never contains the key. */
export async function postJson(
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  req: Pick<ProviderRequest, 'apiKey' | 'timeoutMs'>,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
  try {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted)
        throw new ProviderError('timeout', `no answer within ${req.timeoutMs} ms`);
      throw new ProviderError(
        'network',
        redact(String((err as Error)?.message ?? err), req.apiKey),
      );
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (ctrl.signal.aborted)
        throw new ProviderError('timeout', `no answer within ${req.timeoutMs} ms`);
      throw new ProviderError(
        'network',
        redact(String((err as Error)?.message ?? err), req.apiKey),
      );
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const detail =
        (json as { error?: { message?: unknown } } | undefined)?.error?.message ??
        text.slice(0, 300);
      throw new ProviderError(
        'http',
        redact(`HTTP ${res.status}: ${String(detail).slice(0, 300)}`, req.apiKey),
        res.status,
      );
    }
    if (json === undefined)
      throw new ProviderError('http', 'provider returned a body that is not JSON', res.status);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
