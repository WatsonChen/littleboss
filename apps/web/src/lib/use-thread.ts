import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadDetail } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { isActive } from './format';

const POLL_MS = 2000;

/** Loads a discussion and keeps it fresh while any AI call is still waiting or running. */
export function useThread(client: ApiClient, threadId: string) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const d = await client.getThread(threadId);
      if (!alive.current) return;
      setDetail(d);
      setError(null);
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, threadId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const waiting = detail?.messages.some(isActive) ?? false;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [waiting, detail, refresh]);

  return { detail, error, refresh };
}
