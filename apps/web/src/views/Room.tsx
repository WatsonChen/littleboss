import { useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentInfo, AssetVersionView, MessageView } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { formatUsd, isActive } from '../lib/format';
import { SendFlow } from '../lib/send-flow';
import { needsPerson, useRuns } from '../lib/runs';
import { useThread } from '../lib/use-thread';
import { MessageItem, type MessageActions } from './MessageItem';
import { ConclusionSheet, ConclusionsSheet, ConfirmSheet } from './RoomSheets';
import { HandoffSheet, RunsSheet } from './RunSheets';

const DEFAULT_TITLE = '新的討論';
const MORE_ROUND_TEXT = '請針對還沒解決的分歧和問題，再討論一輪。';

export function Room({
  client,
  threadId,
  openRunId = null,
}: {
  client: ApiClient;
  threadId: string;
  openRunId?: string | null;
}) {
  const { detail, error, refresh } = useThread(client, threadId);
  const { runs, refresh: refreshRuns } = useRuns(client, threadId);
  const [runsOpen, setRunsOpen] = useState(openRunId !== null);
  const [openRun, setOpenRun] = useState<string | null>(openRunId);
  const [handoff, setHandoff] = useState<AssetVersionView | null>(null);
  const [mode, setMode] = useState<'user' | 'context'>('user');
  const [text, setText] = useState('');
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreText, setMoreText] = useState('');
  const [replyTo, setReplyTo] = useState<MessageView | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [conclusions, setConclusions] = useState<AssetVersionView[]>([]);
  const [sheet, setSheet] = useState<
    null | { kind: 'save' } | { kind: 'list' } | { kind: 'edit'; from: AssetVersionView }
  >(null);
  const [now, tick] = useReducer(() => Date.now(), Date.now());
  const textRef = useRef<HTMLTextAreaElement>(null);

  // So the "stuck" label can appear without a reload.
  useEffect(() => {
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, []);

  const loadConclusions = () =>
    client.listConclusions(threadId).then(setConclusions, () => undefined);
  useEffect(() => {
    void loadConclusions();
  }, [threadId]);

  const titleRef = useRef(detail?.thread.title);
  titleRef.current = detail?.thread.title;

  const flow = useMemo(
    () =>
      new SendFlow(client, threadId, (res) => {
        const first = res.messages[0];
        if (first && !res.deduplicated) {
          setText('');
          setReplyTo(null);
          setMoreOpen(false);
          setMoreText('');
          // Name a fresh discussion after its first message.
          if (titleRef.current === DEFAULT_TITLE && first.role === 'user') {
            void client
              .renameThread(threadId, first.content.replace(/\s+/g, ' ').slice(0, 24))
              .catch(() => undefined)
              .then(() => refresh());
            return;
          }
        }
        void refresh();
      }),
    [client, threadId, refresh],
  );
  const flowState = useSyncExternalStore(flow.subscribe, flow.getState);

  if (!detail) {
    return (
      <main className="page">
        <a className="back" href="#/">
          ← 返回
        </a>
        {error ? <p className="error-box">{error}</p> : <p className="muted">載入中…</p>}
      </main>
    );
  }

  const { agents, messages, thread } = detail;
  const hired = agents.filter((a) => a.hired);
  const selectedMsgs = messages.filter((m) => selected.includes(m.id));
  const busy = flowState.step === 'estimating' || flowState.step === 'sending';
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.displayName ?? id;
  const autoOn = thread.participants.length > 0;
  const discussing = thread.participants.length >= 2;
  // "One more round" is offered once the AIs have stopped, and only after they have discussed before.
  const canMoreRound =
    discussing &&
    !messages.some(isActive) &&
    messages.some((m) => m.autoKind === 'summary' || m.autoKind === 'discussion');

  const insertMention = (a: AgentInfo) => {
    setText((t) => `${t}${t && !/\s$/.test(t) ? ' ' : ''}@${a.displayName} `);
    textRef.current?.focus();
  };

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      setNotice(null);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    }
    await refresh();
  }

  const actions: MessageActions = {
    onRetry: (m) => void run(() => client.retry(m.id)),
    onSaveEdit: async (m, content) => {
      await run(() => client.editMessage(m.id, content));
    },
    onReview: (m, reviewer) => {
      setMode('user');
      setReplyTo(m);
      setText(`@${reviewer.displayName} 請檢查上面這則回覆，指出錯誤、遺漏和不合理的地方。`);
      textRef.current?.focus();
    },
    onReplyTo: (m) => {
      setMode('user');
      setReplyTo(m);
      textRef.current?.focus();
    },
    onToggleSelect: (m) =>
      setSelected((s) => (s.includes(m.id) ? s.filter((x) => x !== m.id) : [...s, m.id])),
  };

  return (
    <main className="room">
      <header className="room-head">
        <a className="back" href="#/" aria-label="返回討論列表">
          ←
        </a>
        <div className="room-title">
          <strong>{thread.title}</strong>
          <span className="muted small">
            已用 {formatUsd(thread.spentMicro)} / 上限 {formatUsd(thread.budgetLimitMicro)}
          </span>
        </div>
        <button className="btn-secondary" onClick={() => setSheet({ kind: 'list' })}>
          結論
          {conclusions.length > 0 ? `（${new Set(conclusions.map((c) => c.assetId)).size}）` : ''}
        </button>
        <button className="btn-secondary" onClick={() => setRunsOpen(true)}>
          任務
          {runs.some(needsPerson) && <span className="dot" aria-label="有任務在等你" />}
        </button>
      </header>

      <section className="roster" aria-label="AI 員工">
        {agents.map((a) => (
          <span key={a.id} className={`chip ${a.hired ? 'chip-agent' : 'chip-off'}`}>
            {a.displayName}
            {!a.hired && '（尚未聘用）'}
            {thread.participants.includes(a.id) && thread.participants.length > 0 && ' · 討論'}
            {thread.reviewer === a.id && ' · 檢核'}
          </span>
        ))}
        {autoOn && (
          <p className="muted small">
            {discussing
              ? `你提問後，${thread.participants.map(nameOf).join('、')} 會自動輪流討論（最多 ${thread.maxRounds} 輪，沒新東西會提早結束），最後附小結。`
              : `${nameOf(thread.participants[0]!)} 會直接回答你的提問。`}
            {thread.reviewer ? `你存成結論後，${nameOf(thread.reviewer)} 會自動檢核。` : ''}用 @
            點名則只叫那一位。
          </p>
        )}
        {hired.length < 2 && (
          <p className="muted small">
            要讓 AI 互相檢查，至少需要聘用兩位。目前有 {hired.length} 位。
          </p>
        )}
      </section>

      {(error || notice) && (
        <p className="error-box" role="alert">
          {notice ?? error}
        </p>
      )}

      <section className="messages" aria-live="polite">
        {messages.length === 0 && (
          <p className="empty">先「貼背景」把對話或資料丟進來，再用 @Claude、@GPT 點名誰來回答。</p>
        )}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            m={m}
            agents={agents}
            selected={selected.includes(m.id)}
            now={now}
            actions={actions}
          />
        ))}
        {messages.some(isActive) && (
          <p className="muted small center">有呼叫處理中，這個畫面會自動更新。</p>
        )}
      </section>

      {selected.length > 0 && (
        <div className="selection-bar">
          <span>已選 {selected.length} 則</span>
          <button className="btn-primary" onClick={() => setSheet({ kind: 'save' })}>
            存成結論
          </button>
          <button className="btn-quiet" onClick={() => setSelected([])}>
            清除
          </button>
        </div>
      )}

      {canMoreRound && (
        <div className="more-round">
          {!moreOpen ? (
            <button className="btn-secondary" onClick={() => setMoreOpen(true)}>
              再討論一輪
            </button>
          ) : (
            <>
              <label className="field">
                想讓它們聚焦什麼？（可留空）
                <textarea
                  rows={2}
                  value={moreText}
                  onChange={(e) => setMoreText(e.target.value)}
                  placeholder={MORE_ROUND_TEXT}
                />
              </label>
              <div className="row">
                <button
                  className="btn-primary"
                  disabled={busy}
                  onClick={() =>
                    void flow.begin({
                      content: moreText.trim() || MORE_ROUND_TEXT,
                      kind: 'user',
                      rounds: 1,
                    })
                  }
                >
                  {flowState.step === 'estimating' ? '估算中…' : '開始這一輪'}
                </button>
                <button className="btn-quiet" onClick={() => setMoreOpen(false)}>
                  取消
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim() || busy) return;
          void flow.begin({ content: text.trim(), kind: mode, replyToId: replyTo?.id });
        }}
      >
        <div className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'user'}
            onClick={() => setMode('user')}
          >
            訊息
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'context'}
            onClick={() => setMode('context')}
          >
            貼背景
          </button>
        </div>
        {replyTo && mode === 'user' && (
          <p className="reply-chip">
            針對 {replyTo.agentId ?? '你'} 的訊息：{replyTo.content.slice(0, 30)}…{' '}
            <button
              type="button"
              className="btn-quiet"
              onClick={() => setReplyTo(null)}
              aria-label="取消針對"
            >
              ✕
            </button>
          </p>
        )}
        {mode === 'user' && (
          <div className="mention-row">
            {agents.map((a) => (
              <button
                type="button"
                key={a.id}
                className="btn-chip"
                disabled={!a.hired}
                onClick={() => insertMention(a)}
              >
                @{a.displayName}
                {!a.hired && '（尚未聘用）'}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={mode === 'context' ? 6 : 3}
          placeholder={
            mode === 'context'
              ? '貼上對話紀錄或背景資料。這只會記下來，不會呼叫 AI，也不用錢。'
              : autoOn
                ? '輸入問題，AI 會自動討論。用 @ 點名則只叫那一位。'
                : '輸入問題，用 @ 點名誰要回答。沒有點名就只是記筆記。'
          }
          aria-label={mode === 'context' ? '背景資料' : '訊息'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey))
              e.currentTarget.form?.requestSubmit();
          }}
        />
        <button className="btn-primary send" type="submit" disabled={!text.trim() || busy}>
          {flowState.step === 'estimating' ? '估算中…' : mode === 'context' ? '貼上' : '送出'}
        </button>
      </form>

      {(flowState.step === 'confirm' ||
        flowState.step === 'error' ||
        (flowState.step === 'sending' && flowState.estimate)) && (
        <ConfirmSheet
          state={flowState}
          agents={agents}
          canRetry={flowState.step === 'error' ? flow.canRetry : true}
          onConfirm={() => void flow.confirm()}
          onCancel={() => flow.cancel()}
        />
      )}

      {sheet?.kind === 'save' && (
        <ConclusionSheet
          selected={selectedMsgs}
          agents={agents}
          existing={conclusions}
          onClose={() => setSheet(null)}
          onSave={async (input) => {
            const saved = await client.saveConclusion(threadId, input);
            setSelected([]);
            setSheet(null);
            setNotice(null);
            await loadConclusions();
            setNotice(
              `已存成「${saved.title}」v${saved.version}` +
                (thread.reviewer ? `，${nameOf(thread.reviewer)} 正在檢核` : ''),
            );
            await refresh();
          }}
        />
      )}
      {sheet?.kind === 'edit' && (
        <ConclusionSheet
          selected={[]}
          agents={agents}
          existing={conclusions}
          initial={{
            assetId: sheet.from.assetId,
            title: sheet.from.title,
            content: sheet.from.content,
            sourceMessageIds: sheet.from.sourceMessageIds,
          }}
          onClose={() => setSheet({ kind: 'list' })}
          onSave={async (input) => {
            const saved = await client.saveConclusion(threadId, input);
            await loadConclusions();
            setSheet({ kind: 'list' });
            setNotice(
              `已存成「${saved.title}」v${saved.version}` +
                (thread.reviewer ? `，${nameOf(thread.reviewer)} 正在檢核` : ''),
            );
            await refresh();
          }}
        />
      )}
      {sheet?.kind === 'list' && (
        <ConclusionsSheet
          items={conclusions}
          onClose={() => setSheet(null)}
          onEdit={(latest) => setSheet({ kind: 'edit', from: latest })}
          onHandoff={(latest) => {
            setSheet(null);
            setHandoff(latest);
          }}
        />
      )}
      {handoff && (
        <HandoffSheet
          client={client}
          threadId={threadId}
          conclusion={handoff}
          agents={agents}
          onClose={() => setHandoff(null)}
          onStarted={(run) => {
            setHandoff(null);
            setOpenRun(run.id);
            setRunsOpen(true);
            void refreshRuns();
            void refresh();
          }}
        />
      )}
      {runsOpen && (
        <RunsSheet
          client={client}
          runs={runs}
          openId={openRun}
          onOpen={setOpenRun}
          onChanged={async () => {
            await refreshRuns();
            await refresh();
            await loadConclusions();
          }}
          onClose={() => {
            setRunsOpen(false);
            setOpenRun(null);
            if (openRunId) location.hash = `#/t/${threadId}`;
          }}
        />
      )}
    </main>
  );
}
