import { useCallback, useEffect, useState } from 'react';
import type { ShoppingItemView } from '@littleboss/shared';
import type { ApiClient } from '../api';

export function ShoppingList({ client }: { client: ApiClient }) {
  const [items, setItems] = useState<ShoppingItemView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    client.listShopping().then(
      (r) => {
        setItems(r);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [client]);
  useEffect(load, [load]);

  async function toggle(i: ShoppingItemView) {
    const set = (done: boolean) =>
      setItems((cur) => cur?.map((x) => (x.id === i.id ? { ...x, done } : x)) ?? cur);
    set(!i.done); // shows at once; put back if the server says no
    try {
      const next = await client.setShoppingDone(i.id, !i.done);
      setItems((cur) => cur?.map((x) => (x.id === next.id ? next : x)) ?? cur);
    } catch (e) {
      set(i.done);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  const open = items?.filter((i) => !i.done) ?? [];
  const done = items?.filter((i) => i.done) ?? [];
  const row = (i: ShoppingItemView) => (
    <li key={i.id} className={i.done ? 'shop-done' : ''}>
      <label className="check">
        <input type="checkbox" checked={i.done} onChange={() => void toggle(i)} />
        <span>
          {i.title}
          {i.quantity && <span className="muted"> × {i.quantity}</span>}
          {i.note && <span className="muted small"> · {i.note}</span>}
        </span>
      </label>
    </li>
  );

  return (
    <main className="page narrow">
      <header className="topbar">
        <a className="btn-quiet" href="#/">
          ← 返回
        </a>
        <h1>購物清單</h1>
      </header>
      {error && (
        <p className="error-box" role="alert">
          {error}{' '}
          <button className="btn-quiet" onClick={load}>
            重試
          </button>
        </p>
      )}
      {items === null && !error && <p className="muted">載入中…</p>}
      {items?.length === 0 && (
        <p className="empty">清單是空的。用「隨手捕捉」丟進想買的東西，核准後會出現在這裡。</p>
      )}
      <ul className="shop-list">{open.map(row)}</ul>
      {done.length > 0 && (
        <>
          <h3>已買</h3>
          <ul className="shop-list">{done.map(row)}</ul>
        </>
      )}
      <div className="row">
        <a className="btn-primary" href="#/capture">
          ＋ 隨手捕捉
        </a>
      </div>
    </main>
  );
}
