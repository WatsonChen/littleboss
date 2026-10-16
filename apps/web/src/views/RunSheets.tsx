import { useRef, useState } from 'react';
import type { AgentInfo, AssetVersionView, RunView } from '@littleboss/shared';
import type { ApiClient } from '../api';
import { formatUsd } from '../lib/format';
import { isRunActive, needsPerson, outcomeText, runStateLabel } from '../lib/runs';
import { Sheet } from './Sheet';

const newRequestId = () =>
  `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function CopyButton({ text, label = '複製' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: the text is still on screen to select by hand */
        }
      }}
    >
      {done ? '已複製' : label}
    </button>
  );
}

/** Hand a saved conclusion to an AI. One request id per sheet, so a double tap starts one task. */
export function HandoffSheet(props: {
  client: ApiClient;
  threadId: string;
  conclusion: AssetVersionView;
  agents: AgentInfo[];
  onStarted(run: RunView): void;
  onClose(): void;
}) {
  const hired = props.agents.filter((a) => a.hired);
  const [agentId, setAgentId] = useState(hired[0]?.id ?? '');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(newRequestId());

  async function start() {
    if (busy || !agentId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await props.client.createRun(props.threadId, {
        clientRequestId: requestId.current,
        assetId: props.conclusion.assetId,
        version: props.conclusion.version,
        agentId: agentId as AgentInfo['id'],
        instruction: instruction.trim(),
      });
      props.onStarted(res.run);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Sheet title="交給 AI" onClose={props.onClose}>
      <p>
        <strong>{props.conclusion.title}</strong>{' '}
        <span className="chip">v{props.conclusion.version}</span>
      </p>
      {hired.length === 0 ? (
        <p className="error-text">目前沒有可用的 AI，請先設定 API 金鑰。</p>
      ) : (
        <>
          <label className="field">
            交給誰
            <select value={agentId} onChange={(e) => setAgentId(e.target.value as typeof agentId)}>
              {hired.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            要它做什麼（可留空）
            <textarea
              rows={4}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：排成可以直接照著做的清單"
              maxLength={5000}
            />
          </label>
          <p className="muted small">
            流程：AI 先起草 → 你把草稿帶去用，再把結果貼回來 → AI 修訂 → 你核准後才存成成品。會呼叫
            AI 兩次，費用算進這個討論的預算。
          </p>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="row">
        <button className="btn-primary" disabled={busy || !agentId} onClick={() => void start()}>
          {busy ? '開始中…' : '開始'}
        </button>
        <button className="btn-quiet" onClick={props.onClose}>
          取消
        </button>
      </div>
    </Sheet>
  );
}

function RunDetail(props: { client: ApiClient; run: RunView; onChanged(): Promise<void> | void }) {
  const { run, client } = props;
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function act(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await props.onChanged();
      setBusy(false);
    }
  }

  const pending = run.pending;
  const result = outcomeText(run.outcome);
  const lastText = [...run.steps].reverse().find((s) => s.name === 'propose' && s.text)?.text;

  return (
    <div className="run-detail">
      <p className="muted small">
        {run.config.agentId} · {run.config.model} · 實際 {formatUsd(run.costMicro)}
        {run.reservedMicro > 0 ? ` · 預留 ${formatUsd(run.reservedMicro)}` : ''}
      </p>
      {run.instruction && <p className="msg-body">要求：{run.instruction}</p>}

      <ol className="run-steps">
        {run.steps.map((s) => (
          <li key={s.name} className={`run-step run-step-${s.status}`}>
            <span className="run-step-mark" aria-hidden>
              {s.status === 'done' ? '✓' : s.status === 'active' ? '…' : '●'}
            </span>
            <span>
              {s.label}
              {s.attempts > 1 ? `（試了 ${s.attempts} 次）` : ''}
            </span>
          </li>
        ))}
      </ol>

      {pending?.kind === 'input' && (
        <section className="run-pending" aria-label="等你帶回結果">
          <h3>AI 的草稿</h3>
          <p className="msg-body">{pending.draft}</p>
          <CopyButton text={pending.draft} label="複製草稿" />
          <p className="muted small">{pending.prompt}</p>
          <textarea
            rows={5}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="貼上結果或你的修改意見"
            aria-label="你帶回的結果"
            maxLength={20000}
          />
          <div className="row">
            <button
              className="btn-primary"
              disabled={busy || !text.trim()}
              onClick={() =>
                void act(() => client.submitRunInput(run.id, { stepName: pending.stepName, text }))
              }
            >
              {busy ? '送出中…' : '送出'}
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.submitRunInput(run.id, {
                    stepName: pending.stepName,
                    text: '（沒有要補充）',
                  }),
                )
              }
            >
              沒有要補充
            </button>
          </div>
        </section>
      )}

      {pending?.kind === 'approval' && (
        <section className="run-pending" aria-label="等你核准">
          <h3>要存成成品：{pending.proposal.title}</h3>
          <p className="msg-body">{pending.proposal.content}</p>
          <CopyButton text={pending.proposal.content} />
          <p className="muted small">核准後才會存成新的成品；不核准就什麼都不會存。</p>
          <div className="row">
            <button
              className="btn-primary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.submitRunApproval(run.id, {
                    stepName: pending.stepName,
                    proposalHash: pending.proposal.hash,
                    decision: 'approved',
                  }),
                )
              }
            >
              {busy ? '處理中…' : '核准，存起來'}
            </button>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  client.submitRunApproval(run.id, {
                    stepName: pending.stepName,
                    proposalHash: pending.proposal.hash,
                    decision: 'rejected',
                  }),
                )
              }
            >
              不要
            </button>
          </div>
        </section>
      )}

      {run.state === 'running' && <p className="muted">處理中，這個畫面會自動更新…</p>}

      {!isRunActive(run) && result && (
        <p className={run.state === 'succeeded' ? 'ok-box' : 'error-box'} role="status">
          {result}
        </p>
      )}
      {run.state === 'succeeded' && lastText && (
        <>
          <p className="msg-body">{lastText}</p>
          <CopyButton text={lastText} label="複製成品" />
        </>
      )}

      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}

      {isRunActive(run) && (
        <div className="row">
          {confirmCancel ? (
            <>
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => void act(() => client.cancelRun(run.id))}
              >
                確定取消
              </button>
              <button className="btn-quiet" onClick={() => setConfirmCancel(false)}>
                先不要
              </button>
            </>
          ) : (
            <button className="btn-quiet" onClick={() => setConfirmCancel(true)}>
              取消這個任務
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** All tasks of the discussion; open one to see its steps and answer what it waits for. */
export function RunsSheet(props: {
  client: ApiClient;
  runs: RunView[];
  openId: string | null;
  onOpen(id: string | null): void;
  onChanged(): Promise<void> | void;
  onClose(): void;
}) {
  const open = props.runs.find((r) => r.id === props.openId) ?? null;
  return (
    <Sheet title={open ? open.title : '任務'} onClose={props.onClose}>
      {open ? (
        <>
          <p>
            <span className={`chip ${needsPerson(open) ? 'chip-attn' : ''}`}>
              {runStateLabel(open.state)}
            </span>{' '}
            <button className="btn-quiet" onClick={() => props.onOpen(null)}>
              ← 全部任務
            </button>
          </p>
          <RunDetail client={props.client} run={open} onChanged={props.onChanged} />
        </>
      ) : props.runs.length === 0 ? (
        <p className="empty">還沒有任務。到「結論」裡按「交給 AI」。</p>
      ) : (
        <ul className="run-list">
          {props.runs.map((r) => (
            <li key={r.id}>
              <button className="run-row" onClick={() => props.onOpen(r.id)}>
                <strong>{r.title}</strong>
                <span className={`chip ${needsPerson(r) ? 'chip-attn' : ''}`}>
                  {runStateLabel(r.state)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
