import { z } from 'zod';
import {
  AgentInfo,
  AssetVersionView,
  CallRecord,
  EstimateResponse,
  HealthResponse,
  MessageView,
  CreateRunResponse,
  RunView,
  SendMessageResponse,
  SubmitResponse,
  ThreadDetail,
  ThreadSummary,
  type CreateRunRequest,
  type CreateThreadRequest,
  type EstimateRequest,
  type SaveConclusionRequest,
  type SendMessageRequest,
  type SubmitApprovalRequest,
  type SubmitInputRequest,
} from '@littleboss/shared';

const defaultBase = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/** UI-independent API client. Keep this free of React so it can move to React Native unchanged. */
export async function fetchHealth(
  fetchImpl: typeof fetch = fetch,
  baseUrl = defaultBase,
): Promise<HealthResponse> {
  const res = await fetchImpl(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return HealthResponse.parse(await res.json());
}

/** A failed API call, with the server's machine-readable code (0 / "network" when unreachable). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

export interface ClientOptions {
  baseUrl?: string;
  getToken?: () => string | null;
  /** Called when the server says the access token is missing or wrong. */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
}

export function createApiClient(opts: ClientOptions = {}) {
  const baseUrl = opts.baseUrl ?? defaultBase;
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    body?: unknown,
  ): Promise<z.infer<S>> {
    const headers: Record<string, string> = {};
    const token = opts.getToken?.();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiRequestError(0, 'network', '連不上伺服器，請檢查網路後再試');
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      if (res.status === 401) opts.onUnauthorized?.();
      const e = (json as { error?: { code?: string; message?: string } } | undefined)?.error;
      const details: Record<string, unknown> = { ...e };
      delete details.code;
      delete details.message;
      throw new ApiRequestError(
        res.status,
        e?.code ?? 'http_error',
        e?.message ?? `伺服器回應 ${res.status}`,
        details,
      );
    }
    return schema.parse(json);
  }

  return {
    listAgents: async () =>
      (await request('GET', '/api/agents', z.object({ agents: z.array(AgentInfo) }))).agents,
    listThreads: async () =>
      (await request('GET', '/api/threads', z.object({ threads: z.array(ThreadSummary) }))).threads,
    createThread: async (req: CreateThreadRequest = {}) =>
      (await request('POST', '/api/threads', z.object({ thread: ThreadSummary }), req)).thread,
    renameThread: async (id: string, title: string) =>
      (await request('PATCH', `/api/threads/${id}`, z.object({ thread: ThreadSummary }), { title }))
        .thread,
    getThread: (id: string) => request('GET', `/api/threads/${id}`, ThreadDetail),
    estimate: (id: string, req: EstimateRequest) =>
      request('POST', `/api/threads/${id}/estimate`, EstimateResponse, req),
    sendMessage: (id: string, req: SendMessageRequest) =>
      request('POST', `/api/threads/${id}/messages`, SendMessageResponse, req),
    retry: async (messageId: string) =>
      (
        await request(
          'POST',
          `/api/messages/${messageId}/retry`,
          z.object({ message: MessageView }),
        )
      ).message,
    editMessage: async (messageId: string, content: string) =>
      (
        await request('PATCH', `/api/messages/${messageId}`, z.object({ message: MessageView }), {
          content,
        })
      ).message,
    record: (messageId: string) => request('GET', `/api/messages/${messageId}/record`, CallRecord),
    listConclusions: async (id: string) =>
      (
        await request(
          'GET',
          `/api/threads/${id}/conclusions`,
          z.object({ conclusions: z.array(AssetVersionView) }),
        )
      ).conclusions,
    saveConclusion: async (id: string, req: SaveConclusionRequest) =>
      (
        await request(
          'POST',
          `/api/threads/${id}/conclusions`,
          z.object({ conclusion: AssetVersionView }),
          req,
        )
      ).conclusion,
    createRun: (threadId: string, req: CreateRunRequest) =>
      request('POST', `/api/threads/${threadId}/runs`, CreateRunResponse, req),
    listRuns: async (threadId: string) =>
      (await request('GET', `/api/threads/${threadId}/runs`, z.object({ runs: z.array(RunView) })))
        .runs,
    listWaitingRuns: async () =>
      (await request('GET', '/api/runs/waiting', z.object({ runs: z.array(RunView) }))).runs,
    submitRunInput: (runId: string, req: SubmitInputRequest) =>
      request('POST', `/api/runs/${runId}/input`, SubmitResponse, req),
    submitRunApproval: (runId: string, req: SubmitApprovalRequest) =>
      request('POST', `/api/runs/${runId}/approval`, SubmitResponse, req),
    cancelRun: async (runId: string) =>
      (await request('POST', `/api/runs/${runId}/cancel`, z.object({ run: RunView }), {})).run,
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
