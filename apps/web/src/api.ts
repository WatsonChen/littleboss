import { HealthResponse } from '@littleboss/shared';

const baseUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8787';

/** UI-independent API client. Keep this free of React so it can move to React Native unchanged. */
export async function fetchHealth(fetchImpl: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchImpl(`${baseUrl}/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return HealthResponse.parse(await res.json());
}
