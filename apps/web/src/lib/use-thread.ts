import { useCallback, useEffect, useRef, useState } from 'react';
import type { ThreadDetail } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { isActive } from './format';

const CHAIN_GRACE_MS = 15_000;

/**
 * True right after an automatic discussion turn finished: its next turn is created by the server a
 * moment later, so the screen keeps asking for a little while instead of looking finished.
 */
export function chainMayContinue(messages: ThreadDetail['messages'], now: number): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'agent' || last.autoKind !== 'discussion') return false;
  if (last.status !== 'succeeded' || !last.finishedAt) return false;
  return now - Date.parse(last.finishedAt) < CHAIN_GRACE_MS;
}

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

  const waiting =
    (detail?.messages.some(isActive) || chainMayContinue(detail?.messages ?? [], Date.now())) ??
    false;
  useEffect(() => {
    if (!waiting) return;
    const t = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [waiting, detail, refresh]);

  return { detail, error, refresh };
}
