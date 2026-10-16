import { useCallback, useEffect, useRef, useState } from 'react';
import type { RunOutcome, RunState, RunView } from '@littleboss/shared';
import type { ApiClient } from '../api';

export function runStateLabel(state: RunState): string {
  switch (state) {
    case 'running':
      return '進行中';
    case 'waiting_input':
      return '等你帶回結果';
    case 'waiting_approval':
      return '等你核准';
    case 'succeeded':
      return '完成';
    case 'rejected':
      return '你沒有核准';
    case 'needs_reapproval':
      return '需要重新核准';
    case 'failed':
      return '失敗';
    case 'cancelled':
      return '已取消';
  }
}

export const isRunActive = (r: Pick<RunView, 'state'>) =>
  r.state === 'running' || r.state === 'waiting_input' || r.state === 'waiting_approval';

/** Waiting on the person (not on the AI). */
export const needsPerson = (r: Pick<RunView, 'state'>) =>
  r.state === 'waiting_input' || r.state === 'waiting_approval';

const FAILURES: Record<string, string> = {
  truncated: 'AI 的回覆在中途被截斷，沒有可用的結果。',
  refused: 'AI 拒絕回答這個任務。',
  empty: 'AI 回了空白的內容。',
  provider_unavailable: '連不上 AI（已自動重試過）。稍後再開一個新任務。',
  auth_failed: 'AI 的 API 金鑰不能用，請檢查金鑰與額度。',
  provider_rejected: 'AI 服務拒絕了這個請求。',
  agent_not_hired: '這位 AI 目前沒有設定。',
};

export function outcomeText(o: RunOutcome | null): string | null {
  if (!o) return null;
  switch (o.status) {
    case 'succeeded':
      return `已存成成品（v${o.version}）。`;
    case 'rejected':
      return '你沒有核准，所以什麼都沒有存。';
    case 'needs_reapproval':
      return '你核准的內容和現在的不一致，所以沒有存。請重新開一個任務。';
    case 'failed':
      return FAILURES[o.code] ?? o.reason;
    case 'cancelled':
      return '任務已取消，沒有再花費。';
  }
}

const POLL_MS = 3000;

/** The runs of one discussion; refreshes while any run is still working. */
export function useRuns(client: ApiClient, threadId: string) {
  const [runs, setRuns] = useState<RunView[]>([]);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const r = await client.listRuns(threadId);
      if (alive.current) setRuns(r);
    } catch {
      /* the room shows connection trouble through its own polling */
    }
  }, [client, threadId]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive.current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh]);

  const working = runs.some((r) => r.state === 'running');
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [working, runs, refresh]);

  return { runs, refresh };
}
