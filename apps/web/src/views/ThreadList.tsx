import { useCallback, useEffect, useState } from 'react';
import type { RunView, ThreadSummary } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { formatUsd } from '../lib/format';
import { runStateLabel } from '../lib/runs';

export function ThreadList({ client }: { client: ApiClient }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [waiting, setWaiting] = useState<RunView[]>([]);

  const load = useCallback(() => {
    client
      .listThreads()
      .then((t) => {
        setThreads(t);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client]);
  useEffect(load, [load]);
  useEffect(() => {
    // The tasks that wait for the person are a convenience: a failure here never blocks the list.
    client.listWaitingRuns().then(setWaiting, () => undefined);
  }, [client]);

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      const t = await client.createThread({});
      location.hash = `#/t/${t.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1>little boss</h1>
        <button className="btn-primary" onClick={create} disabled={creating}>
          ＋ 新討論
        </button>
      </header>
      {error && (
        <p className="error-box" role="alert">
          {error}{' '}
          <button className="btn-quiet" onClick={load}>
            重試
          </button>
        </p>
      )}
      {waiting.length > 0 && (
        <section className="waiting-box" aria-label="等你處理">
          <h2>等你處理（{waiting.length}）</h2>
          <ul className="thread-list">
            {waiting.map((r) => (
              <li key={r.id}>
                <a href={`#/t/${r.threadId}/r/${r.id}`}>
                  <strong>{r.title}</strong>
                  <span className="muted small">{runStateLabel(r.state)}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
      {threads === null && !error && <p className="muted">載入中…</p>}
      {threads?.length === 0 && (
        <p className="empty">還沒有討論。按「新討論」，把問題丟給你的 AI 員工。</p>
      )}
      <ul className="thread-list">
        {threads?.map((t) => (
          <li key={t.id}>
            <a href={`#/t/${t.id}`}>
              <strong>{t.title}</strong>
              <span className="muted small">
                {t.messageCount} 則 · 已用 {formatUsd(t.spentMicro)} /{' '}
                {formatUsd(t.budgetLimitMicro)} ·{' '}
                {new Date(t.updatedAt).toLocaleString('zh-TW', {
                  dateStyle: 'short',
                  timeStyle: 'short',
                })}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
