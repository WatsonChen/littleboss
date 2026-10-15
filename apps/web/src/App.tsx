import { useEffect, useState } from 'react';
import { fetchHealth } from './api';

type State =
  { kind: 'loading' } | { kind: 'ok'; time: string } | { kind: 'error'; message: string };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    fetchHealth()
      .then((h) => setState({ kind: 'ok', time: h.time }))
      .catch((e: unknown) =>
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
      );
  }, []);

  return (
    <main style={{ padding: 'var(--space)' }}>
      <h1>little boss</h1>
      <p>
        後端狀態：
        {state.kind === 'loading' && '檢查中…'}
        {state.kind === 'ok' && `正常（${state.time}）`}
        {state.kind === 'error' && `無法連線：${state.message}`}
      </p>
    </main>
  );
}
