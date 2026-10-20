import { useMemo, useState } from 'react';
import type { AgentInfo, AssetVersionView, MessageView } from '@littleboss/shared';
import { formatUsd } from '../lib/format';
import type { SendFlowState } from '../lib/send-flow';
import { Sheet } from './Sheet';

export function ConfirmSheet(props: {
  state: Extract<SendFlowState, { step: 'confirm' | 'sending' | 'error' }>;
  agents: AgentInfo[];
  canRetry: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { state } = props;
  const estimate = state.step === 'error' ? state.estimate : state.estimate;
  const sending = state.step === 'sending';
  const name = (id: string) => props.agents.find((a) => a.id === id)?.displayName ?? id;
  const over = estimate ? !estimate.withinBudget : false;
  return (
    <Sheet title={state.step === 'error' ? '沒有送出' : '確認送出'} onClose={props.onCancel}>
      {state.step === 'error' && (
        <p className="error-box" role="alert">
          {state.message}
        </p>
      )}
      {state.step === 'confirm' && state.notice && <p className="error-text">{state.notice}</p>}
      {estimate && (
        <>
          <ul className="estimate-list">
            {estimate.auto ? (
              <li>
                <span>
                  AI 會自動輪流討論，最多 {estimate.auto.maxTurns} 次呼叫
                  {estimate.auto.includesSummary ? '（含小結）' : ''}
                </span>
              </li>
            ) : (
              estimate.calls.map((c) => (
                <li key={c.agentId}>
                  <span>呼叫 {name(c.agentId)}</span>
                  <span>最多約 {formatUsd(c.estimatedCostMicro)}</span>
                </li>
              ))
            )}
            <li className="total">
              <span>{estimate.auto ? '最多（估算）' : '合計（估算）'}</span>
              <span>約 {formatUsd(estimate.totalMicro)}</span>
            </li>
          </ul>
          {estimate.auto && (
            <p className="muted small">
              這是全部輪次都講滿的上限。AI 覺得沒有新東西可說就會提早結束，實際通常更少。
            </p>
          )}
          <p className="muted small">
            這是送出前的估算，實際依 AI 回報的用量計費。本討論已用 {formatUsd(estimate.spentMicro)}
            ，上限 {formatUsd(estimate.budgetLimitMicro)}。
          </p>
          {over && <p className="error-text">這會超過本討論的預算上限，無法送出。</p>}
        </>
      )}
      <div className="row">
        {(state.step === 'confirm' || (state.step === 'error' && props.canRetry) || sending) && (
          <button
            className="btn-primary"
            disabled={sending || over}
            onClick={props.onConfirm}
            aria-busy={sending}
          >
            {sending ? '送出中…' : state.step === 'error' ? '再試一次' : '確認送出'}
          </button>
        )}
        <button className="btn-quiet" onClick={props.onCancel} disabled={sending}>
          {state.step === 'error' ? '關閉' : '取消'}
        </button>
      </div>
    </Sheet>
  );
}

export function ConclusionSheet(props: {
  selected: MessageView[];
  agents: AgentInfo[];
  existing: AssetVersionView[];
  initial?: { assetId: string; title: string; content: string; sourceMessageIds: string[] };
  onSave(input: {
    title: string;
    content: string;
    sourceMessageIds: string[];
    assetId?: string;
  }): Promise<void>;
  onClose(): void;
}) {
  const latest = useMemo(() => {
    const m = new Map<string, AssetVersionView>();
    for (const v of props.existing.filter((x) => x.kind === 'conclusion'))
      if (!m.has(v.assetId) || v.version > m.get(v.assetId)!.version) m.set(v.assetId, v);
    return [...m.values()];
  }, [props.existing]);

  const joined = props.selected.map((m) => m.content).join('\n\n');
  const [title, setTitle] = useState(
    props.initial?.title ?? joined.replace(/\s+/g, ' ').slice(0, 24),
  );
  const [content, setContent] = useState(props.initial?.content ?? joined);
  const [assetId, setAssetId] = useState<string>(props.initial?.assetId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sourceIds = props.initial?.sourceMessageIds ?? props.selected.map((m) => m.id);

  return (
    <Sheet title={props.initial ? '編輯成新版本' : '存成結論'} onClose={props.onClose}>
      {!props.initial && latest.length > 0 && (
        <label className="field">
          存到
          <select value={assetId} onChange={(e) => setAssetId(e.target.value)}>
            <option value="">新的結論</option>
            {latest.map((a) => (
              <option key={a.assetId} value={a.assetId}>
                加為「{a.title}」的新版本（目前 v{a.version}）
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        標題
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        內容（可以直接修改或合併多則）
        <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={10} />
      </label>
      <p className="muted small">每次儲存都是新的版本，舊版本不會被覆蓋。</p>
      {error && <p className="error-text">{error}</p>}
      <div className="row">
        <button
          className="btn-primary"
          disabled={saving || !title.trim() || !content.trim()}
          onClick={async () => {
            setSaving(true);
            setError(null);
            try {
              await props.onSave({
                title: title.trim(),
                content: content.trim(),
                sourceMessageIds: sourceIds,
                assetId: assetId || undefined,
              });
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setSaving(false);
            }
          }}
        >
          {saving ? '儲存中…' : '儲存'}
        </button>
        <button className="btn-quiet" onClick={props.onClose}>
          取消
        </button>
      </div>
    </Sheet>
  );
}

export function ConclusionsSheet(props: {
  items: AssetVersionView[];
  onEdit(latest: AssetVersionView): void;
  onHandoff(latest: AssetVersionView): void;
  onClose(): void;
}) {
  const [conclusions, deliverables] = useMemo(() => {
    const m = new Map<string, AssetVersionView[]>();
    for (const v of props.items) m.set(v.assetId, [...(m.get(v.assetId) ?? []), v]);
    const groups = [...m.values()].map((vs) => vs.sort((a, b) => b.version - a.version));
    return [
      groups.filter((vs) => vs[0]!.kind === 'conclusion'),
      groups.filter((vs) => vs[0]!.kind === 'deliverable'),
    ];
  }, [props.items]);
  return (
    <Sheet title="結論與成品" onClose={props.onClose}>
      <h3>結論</h3>
      {conclusions.length === 0 && <p className="empty">還沒有結論。在訊息上按「選為結論」。</p>}
      {conclusions.map((vs) => (
        <details key={vs[0]!.assetId} className="asset">
          <summary>
            <strong>{vs[0]!.title}</strong> <span className="chip">v{vs[0]!.version}</span>
          </summary>
          <p className="msg-body">{vs[0]!.content}</p>
          <div className="row">
            <button className="btn-primary" onClick={() => props.onHandoff(vs[0]!)}>
              交給 AI
            </button>
            <button className="btn-secondary" onClick={() => props.onEdit(vs[0]!)}>
              編輯成新版本
            </button>
          </div>
          {vs.length > 1 && (
            <details className="older">
              <summary className="muted small">舊版本（{vs.length - 1}）</summary>
              {vs.slice(1).map((v) => (
                <div key={v.version}>
                  <span className="chip">v{v.version}</span>
                  <p className="msg-body">{v.content}</p>
                </div>
              ))}
            </details>
          )}
        </details>
      ))}
      {deliverables.length > 0 && (
        <>
          <h3>成品（AI 做好、你核准過的）</h3>
          {deliverables.map((vs) => (
            <details key={vs[0]!.assetId} className="asset">
              <summary>
                <strong>{vs[0]!.title}</strong> <span className="chip">成品</span>
              </summary>
              <p className="msg-body">{vs[0]!.content}</p>
            </details>
          ))}
        </>
      )}
    </Sheet>
  );
}
