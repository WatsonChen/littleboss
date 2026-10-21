import { useCallback, useEffect, useState } from 'react';
import type { RunView, ThreadSummary } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { formatUsd } from '../lib/format';
import { runStateLabel } from '../lib/runs';
import { NewThreadSheet } from './NewThreadSheet';

export function ThreadList({ client }: { client: ApiClient }) {
  const [threads, setThreads] = useState<ThreadSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
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

  return (
    <main className="page">
      <header className="topbar">
        <h1>little boss</h1>
        <button className="btn-primary" onClick={() => setNewOpen(true)}>
          ＋ 新討論
        </button>
      </header>
      <nav className="home-tools" aria-label="工具">
        <a className="btn-secondary" href="#/capture">
          📝 隨手捕捉
        </a>
        <a className="btn-secondary" href="#/shopping">
          🛒 購物清單
        </a>
        <a className="btn-secondary" href="#/flows">
          🎙 流程
        </a>
      </nav>
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
                {t.participants.length > 0 && `${t.participants.length} 位 AI · `}
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
      {newOpen && (
        <NewThreadSheet
          client={client}
          onClose={() => setNewOpen(false)}
          onCreate={async (req) => {
            const t = await client.createThread(req);
            location.hash = `#/t/${t.id}`;
          }}
        />
      )}
    </main>
  );
}
