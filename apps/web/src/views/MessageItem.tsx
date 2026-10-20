import { useState } from 'react';
import type { AgentInfo, MessageView } from '@littleboss/shared';
import { isActive, isStuck, messageCostLabel, statusLabel } from '../lib/format';

export interface MessageActions {
  onRetry(m: MessageView): void;
  onSaveEdit(m: MessageView, content: string): Promise<void>;
  onReview(m: MessageView, reviewer: AgentInfo): void;
  onReplyTo(m: MessageView): void;
  onToggleSelect(m: MessageView): void;
}

export function MessageItem(props: {
  m: MessageView;
  agents: AgentInfo[];
  selected: boolean;
  now: number;
  actions: MessageActions;
}) {
  const { m, agents, selected, now, actions } = props;
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (m.role === 'context') {
    const long = m.content.length > 160;
    return (
      <article className="msg msg-context" aria-label="背景資料">
        <div className="msg-head">
          <span className="chip">背景資料</span>
        </div>
        <p className="msg-body">{expanded || !long ? m.content : `${m.content.slice(0, 160)}…`}</p>
        {long && (
          <button className="btn-quiet" onClick={() => setExpanded(!expanded)}>
            {expanded ? '收合' : '展開'}
          </button>
        )}
      </article>
    );
  }

  if (m.role === 'user' && m.autoKind === 'review_request') {
    // The boss did not type this: it records that saving a conclusion asked the reviewer to check it.
    return (
      <p className="msg-note muted small" aria-label="自動檢核">
        🔍 {m.content}（自動）
      </p>
    );
  }

  if (m.role === 'user') {
    return (
      <article className={`msg msg-user${selected ? ' selected' : ''}`}>
        <p className="msg-body">{m.content}</p>
        <div className="msg-actions">
          <button
            className="btn-quiet"
            onClick={() => actions.onToggleSelect(m)}
            aria-pressed={selected}
          >
            {selected ? '✓ 已選為結論' : '選為結論'}
          </button>
        </div>
      </article>
    );
  }

  const agent = agents.find((a) => a.id === m.agentId);
  const name = agent?.displayName ?? m.agentId ?? 'AI';
  const cost = messageCostLabel(m);
  const stuck = isStuck(m, now);
  const retryable =
    m.status === 'failed' || m.status === 'timed_out' || m.status === 'bad_format' || stuck;
  const reviewers = agents.filter((a) => a.hired && a.id !== m.agentId);

  return (
    <article className={`msg msg-agent agent-${m.agentId}${selected ? ' selected' : ''}`}>
      <div className="msg-head">
        <span className="chip chip-agent">{name}</span>
        {m.autoKind === 'summary' && <span className="chip chip-attn">小結</span>}
        {m.autoKind === 'review' && <span className="chip chip-attn">檢核</span>}
        {statusLabel(m) && <span className={`status status-${m.status}`}>{statusLabel(m)}</span>}
        {m.editedByUser && <span className="status">已手動修改</span>}
        {cost && <span className="muted small cost">{cost}</span>}
      </div>

      {isActive(m) && !stuck && (
        <p className="muted">{name} 正在處理，可以先離開，回來時結果會在這裡。</p>
      )}
      {stuck && <p className="error-text">這則呼叫似乎卡住了。</p>}

      {m.error && (
        <p className="error-box" role="alert">
          {m.error.message}
        </p>
      )}

      {editing === null ? (
        m.content && <p className="msg-body">{m.content}</p>
      ) : (
        <div>
          <textarea
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            rows={8}
            aria-label="修正回覆內容"
          />
          <div className="row">
            <button
              className="btn-primary"
              disabled={saving || !editing.trim()}
              onClick={async () => {
                setSaving(true);
                try {
                  await actions.onSaveEdit(m, editing);
                  setEditing(null);
                } finally {
                  setSaving(false);
                }
              }}
            >
              儲存修正
            </button>
            <button className="btn-quiet" onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      )}

      {m.autoKind === 'discussion' && m.autoDone === true && m.status === 'succeeded' && (
        <p className="muted small">{name} 認為沒有更多要補充了。</p>
      )}

      <div className="msg-actions">
        {m.status === 'bad_format' && editing === null && (
          <button className="btn-secondary" onClick={() => setEditing(m.content)}>
            手動修正
          </button>
        )}
        {retryable && (
          <button className="btn-secondary" onClick={() => actions.onRetry(m)}>
            重試（會再計一次費用）
          </button>
        )}
        {m.status === 'succeeded' && (
          <>
            {reviewers.map((r) => (
              <button key={r.id} className="btn-secondary" onClick={() => actions.onReview(m, r)}>
                請 {r.displayName} 檢查
              </button>
            ))}
            <button className="btn-quiet" onClick={() => actions.onReplyTo(m)}>
              針對這則回覆
            </button>
            <button
              className="btn-quiet"
              onClick={() => actions.onToggleSelect(m)}
              aria-pressed={selected}
            >
              {selected ? '✓ 已選為結論' : '選為結論'}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
