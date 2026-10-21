import { useEffect, useState } from 'react';
import type { AgentId, AgentInfo, CreateThreadRequest } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { Sheet } from './Sheet';

/** Choose who discusses, who checks the conclusion, and how many rounds at most. */
export function NewThreadSheet(props: {
  client: ApiClient;
  onCreate(req: CreateThreadRequest): Promise<void>;
  onClose(): void;
}) {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [participants, setParticipants] = useState<AgentId[]>([]);
  const [reviewer, setReviewer] = useState<AgentId | ''>('');
  const [rounds, setRounds] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    props.client.listAgents().then(
      (list) => {
        setAgents(list);
        const hired = list.filter((a) => a.hired);
        // Sensible start: the first two discuss, a third (if any) checks.
        setParticipants(hired.slice(0, 2).map((a) => a.id));
        setReviewer(hired[2]?.id ?? '');
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [props.client]);

  const hired = agents?.filter((a) => a.hired) ?? [];
  const toggle = (id: AgentId) =>
    setParticipants((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  async function create() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await props.onCreate({
        participants,
        reviewer: reviewer || null,
        maxRounds: rounds,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const names = (ids: AgentId[]) =>
    ids.map((id) => agents?.find((a) => a.id === id)?.displayName ?? id);

  return (
    <Sheet title="新討論" onClose={props.onClose}>
      {!agents && !error && <p className="muted">載入中…</p>}
      {agents && hired.length === 0 && (
        <p className="error-text">目前沒有可用的 AI，請先設定 API 金鑰。</p>
      )}
      {agents && hired.length > 0 && (
        <>
          <fieldset className="field-group">
            <legend>誰來參與討論</legend>
            {hired.map((a) => (
              <label key={a.id} className="pick">
                <input
                  type="checkbox"
                  checked={participants.includes(a.id)}
                  onChange={() => toggle(a.id)}
                />
                {a.displayName}
              </label>
            ))}
            <p className="muted small">
              {participants.length >= 2
                ? `你丟出問題後，${names(participants).join('、')} 會自動輪流互相回應。`
                : participants.length === 1
                  ? '只選一位時，它會直接回答你的問題。要讓 AI 互相討論，請選兩位以上。'
                  : '不選的話，只有你用 @ 點名時 AI 才會回答。'}
            </p>
          </fieldset>

          {participants.length >= 2 && (
            <label className="field">
              最多討論幾輪（上限，不是目標）
              <select value={rounds} onChange={(e) => setRounds(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} 輪
                  </option>
                ))}
              </select>
              <span className="muted small">
                AI 覺得沒有新東西可說就會提早結束，結束後會附上小結（共識、分歧、未解決的問題）。
              </span>
            </label>
          )}

          <label className="field">
            誰來檢核結論
            <select value={reviewer} onChange={(e) => setReviewer(e.target.value as AgentId | '')}>
              <option value="">不指定</option>
              {hired.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                  {participants.includes(a.id) ? '（也是參與者）' : ''}
                </option>
              ))}
            </select>
            <span className="muted small">
              你把某則訊息存成結論後，檢核員會自動進來檢查，結果貼回對話。
            </span>
          </label>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn-primary" disabled={busy || !agents} onClick={() => void create()}>
          {busy ? '建立中…' : '開始'}
        </button>
        <button className="btn-quiet" onClick={props.onClose}>
          取消
        </button>
      </div>
    </Sheet>
  );
}
