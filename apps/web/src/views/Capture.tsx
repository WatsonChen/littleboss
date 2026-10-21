import { useRef, useState } from 'react';
import type { CaptureItemView, CaptureView } from '@littleboss/shared';
import type { ApiClient } from '../api';
import {
  formatWhen,
  itemStatusLabel,
  newCaptureRequestId,
  toLocalInput,
  toOffsetString,
  useCapture,
} from '../lib/captures';
import { formatUsd } from '../lib/format';

const ERRORS: Record<string, string> = {
  truncated: 'AI 的回覆在中途被截斷了。',
  refused: 'AI 拒絕處理這段內容。',
  provider_unavailable: '連不上 AI（已自動重試過）。',
  bad_format: 'AI 的回覆我看不懂。',
};

/** Type or dictate a note; nothing is created until the person starts it. */
export function CaptureHome({ client }: { client: ApiClient }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One id per draft: a double tap, or a retry after a dropped connection, starts one capture.
  const requestId = useRef(newCaptureRequestId());

  async function start() {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await client.createCapture({
        clientRequestId: requestId.current,
        text: text.trim(),
      });
      location.hash = `#/capture/${res.capture.id}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <header className="topbar">
        <a className="btn-quiet" href="#/">
          ← 返回
        </a>
        <h1>隨手捕捉</h1>
      </header>
      <p className="muted small">
        打字或用手機鍵盤的語音輸入，把想到的事丟進來。AI 會整理成「要買的東西」和「行事曆活動」，
        你逐項看過、核准後才會寫入。
      </p>
      <label className="field">
        想到什麼就寫什麼
        <textarea
          rows={6}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Changed text is a different note, so it gets its own id.
            requestId.current = newCaptureRequestId();
          }}
          placeholder="例如：明天下午三點跟小美吃飯，要買牛奶和衛生紙，下週找時間看牙醫"
          maxLength={8000}
        />
      </label>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button
          className="btn-primary"
          disabled={busy || !text.trim()}
          onClick={() => void start()}
        >
          {busy ? '送出中…' : '交給 AI 整理'}
        </button>
        <a className="btn-secondary" href="#/shopping">
          購物清單
        </a>
      </div>
    </main>
  );
}

function ItemCard(props: {
  client: ApiClient;
  capture: CaptureView;
  item: CaptureItemView;
  onCapture(c: CaptureView): void;
  onRefresh(): Promise<void>;
}) {
  const { item, client, capture } = props;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(item.title);
  const [note, setNote] = useState(item.note);
  const [quantity, setQuantity] = useState(item.quantity);
  const [allDay, setAllDay] = useState(item.allDay);
  const [start, setStart] = useState(toLocalInput(item.startsAt));
  const [end, setEnd] = useState(toLocalInput(item.endsAt));
  const [startDay, setStartDay] = useState(item.allDay ? (item.startsAt ?? '') : '');

  async function act(fn: () => Promise<CaptureView | { capture: CaptureView }>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      props.onCapture('capture' in r ? r.capture : r);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await props.onRefresh();
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    const body: Parameters<ApiClient['editCaptureItem']>[2] = { title, note };
    if (item.kind === 'shopping') body.quantity = quantity;
    else {
      body.allDay = allDay;
      if (allDay) {
        body.startsAt = startDay || null;
        body.endsAt = null;
      } else {
        const s = start ? toOffsetString(start, item.timeZone) : null;
        if (start && !s) return setError('開始時間格式不對');
        body.startsAt = s;
        body.endsAt = end ? toOffsetString(end, item.timeZone) : null;
      }
    }
    if (await act(() => client.editCaptureItem(capture.id, item.id, body))) setEditing(false);
  }

  const settled = item.status === 'saved' || item.status === 'rejected';
  const canAct = item.status === 'proposed' || item.status === 'failed';
  return (
    <li className={`cap-item cap-${item.status}`}>
      <div className="cap-head">
        <span className="chip">{item.kind === 'shopping' ? '🛒 買' : '📅 行程'}</span>
        {item.origin === 'suggested' && <span className="chip chip-attn">AI 建議的</span>}
        <span className="muted small cap-status">{itemStatusLabel(item.status)}</span>
      </div>

      {editing ? (
        <div className="cap-edit">
          <label className="field">
            名稱
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          {item.kind === 'shopping' ? (
            <label className="field">
              數量（可留空）
              <input
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                maxLength={50}
              />
            </label>
          ) : (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => setAllDay(e.target.checked)}
                />
                全天
              </label>
              {allDay ? (
                <label className="field">
                  日期
                  <input
                    type="date"
                    value={startDay}
                    onChange={(e) => setStartDay(e.target.value)}
                  />
                </label>
              ) : (
                <>
                  <label className="field">
                    開始（{item.timeZone}）
                    <input
                      type="datetime-local"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </label>
                  <label className="field">
                    結束（可留空，預設 1 小時）
                    <input
                      type="datetime-local"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label className="field">
            備註（可留空）
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={1000}
            />
          </label>
          <div className="row">
            <button
              className="btn-primary"
              disabled={busy || !title.trim()}
              onClick={() => void save()}
            >
              {busy ? '儲存中…' : '儲存修改'}
            </button>
            <button className="btn-quiet" disabled={busy} onClick={() => setEditing(false)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="cap-title">
            <strong>{item.title}</strong>
            {item.quantity && <span className="muted"> × {item.quantity}</span>}
          </p>
          {item.kind === 'event' && (
            <p className="small">{formatWhen(item.startsAt, item.allDay)}</p>
          )}
          {item.note && <p className="muted small">{item.note}</p>}
          {item.assumptions.length > 0 && (
            <p className="small cap-guess">
              <span className="chip">推測</span> {item.assumptions.join('；')}
            </p>
          )}
          {item.warnings.map((w) => (
            <p key={w} className="small cap-warn">
              ⚠ {w}
            </p>
          ))}
          {item.status === 'needs_info' && item.question && (
            <p className="cap-question">❓ {item.question}</p>
          )}
        </>
      )}

      {item.status === 'saved' && item.result && (
        <p className="small ok-box">
          {item.result.destination === 'little-boss-shopping' && '已加進購物清單。'}
          {item.result.demo &&
            '示範：只存在 little boss 的示範行事曆，沒有寫進真的 Google 行事曆。'}
          {item.result.destination === 'google-calendar' && '已寫進 Google 行事曆。'}
          {item.result.link && (
            <>
              {' '}
              <a href={item.result.link} target="_blank" rel="noreferrer">
                打開
              </a>
            </>
          )}
        </p>
      )}
      {item.status === 'failed' && item.error && (
        <p className="error-text" role="alert">
          {item.error.message}
        </p>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {!editing && !settled && item.status !== 'writing' && (
        <div className="row">
          {canAct && (
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.approveCaptureItem(capture.id, item.id, { payloadHash: item.payloadHash }),
                )
              }
            >
              {busy ? '處理中…' : item.status === 'failed' ? '再試一次' : '核准'}
            </button>
          )}
          <button className="btn-secondary" disabled={busy} onClick={() => setEditing(true)}>
            {item.status === 'needs_info' ? '補上時間' : '修改'}
          </button>
          <button
            className="btn-quiet"
            disabled={busy}
            onClick={() => void act(() => client.rejectCaptureItem(capture.id, item.id))}
          >
            不要
          </button>
        </div>
      )}
    </li>
  );
}

export function CaptureDetail({ client, id }: { client: ApiClient; id: string }) {
  const { capture, error, refresh, setCapture } = useCapture(client, id);
  const [busy, setBusy] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    if (!capture || busy) return;
    setBusy(true);
    setRetryError(null);
    try {
      setCapture(await client.retryCapture(capture.id));
    } catch (e) {
      setRetryError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <header className="topbar">
        <a className="btn-quiet" href="#/capture">
          ← 再捕捉一筆
        </a>
        <h1>整理結果</h1>
      </header>
      {error && !capture && (
        <p className="error-box" role="alert">
          {error}{' '}
          <button className="btn-quiet" onClick={() => void refresh()}>
            重試
          </button>
        </p>
      )}
      {!capture && !error && <p className="muted">載入中…</p>}
      {capture && (
        <>
          <p className="msg-body cap-source">{capture.text}</p>
          {(capture.state === 'queued' || capture.state === 'parsing') && (
            <p className="muted" role="status">
              AI 正在整理…
            </p>
          )}
          {capture.state === 'failed' && (
            <div className="error-box" role="alert">
              <p>{capture.error?.message ?? ERRORS[capture.error?.code ?? ''] ?? '整理失敗了。'}</p>
              {retryError && <p>{retryError}</p>}
              <button className="btn-secondary" disabled={busy} onClick={() => void retry()}>
                {busy ? '重試中…' : '再讀一次'}
              </button>
            </div>
          )}
          {capture.state === 'ready' && (
            <>
              {capture.items.length === 0 && <p className="empty">AI 沒有找到可以整理的事。</p>}
              <ul className="cap-list">
                {capture.items.map((item) => (
                  <ItemCard
                    key={item.id}
                    client={client}
                    capture={capture}
                    item={item}
                    onCapture={setCapture}
                    onRefresh={refresh}
                  />
                ))}
              </ul>
              {capture.questions.length > 0 && (
                <section className="waiting-box" aria-label="AI 想問你">
                  <h2>AI 想問你</h2>
                  <ul>
                    {capture.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                  <p className="muted small">想回答的話，把補充寫進新的一筆捕捉。</p>
                </section>
              )}
            </>
          )}
          <p className="muted small">
            AI 費用 {formatUsd(capture.costMicro)}
            {capture.attemptCount > 1 ? ` · 讀了 ${capture.attemptCount} 次` : ''}
          </p>
          <div className="row">
            <a className="btn-secondary" href="#/shopping">
              購物清單
            </a>
          </div>
        </>
      )}
    </main>
  );
}
