import { useCallback, useEffect, useState } from 'react';
import type { FlowDraftOption, FlowStepView, FlowView } from '@littleboss/shared';
import type { ApiClient } from '../api';
import {
  copyText,
  formatPublishAt,
  missingForHandoff,
  nextStep,
  pasteablePublishAt,
  progressLabel,
} from '../lib/flows';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function FlowHome({ client }: { client: ApiClient }) {
  const [flows, setFlows] = useState<FlowView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    client.listFlows().then(
      (r) => {
        setFlows(r);
        setError(null);
      },
      (e: unknown) => setError(message(e)),
    );
  }, [client]);
  useEffect(load, [load]);

  async function create() {
    setBusy(true);
    try {
      const { flow } = await client.createFlow({
        clientRequestId: crypto.randomUUID(),
        template: 'podcast-episode',
      });
      location.hash = `#/flows/${flow.id}`;
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  }

  return (
    <main className="page narrow">
      <header className="topbar">
        <a className="btn-quiet" href="#/">
          ← 返回
        </a>
        <h1>流程</h1>
        <button className="btn-primary" onClick={() => void create()} disabled={busy}>
          ＋ 新的一集
        </button>
      </header>
      <p className="muted small">
        Podcast 上架：從寫重點、AI 擬標題，到貼進 Firstory，一步步帶著你走。
      </p>
      {error && (
        <p className="error-box" role="alert">
          {error}{' '}
          <button className="btn-quiet" onClick={load}>
            重試
          </button>
        </p>
      )}
      {flows?.length === 0 && <p className="muted">還沒有任何一集。按右上角「新的一集」開始。</p>}
      <ul className="flow-list">
        {flows?.map((f) => (
          <li key={f.id}>
            <a className={`flow-card flow-card-${f.state}`} href={`#/flows/${f.id}`}>
              <span className="flow-card-title">{f.title}</span>
              <span className="muted small">
                {f.state === 'done' ? '✓ 完成' : `進度 ${progressLabel(f)}`}
                {f.publishAt && ` · 發佈 ${formatPublishAt(f.publishAt)}`}
              </span>
              {f.state === 'active' && nextStep(f) && (
                <span className="small">下一步：{nextStep(f)!.title}</span>
              )}
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}

export function FlowDetail({ client, id }: { client: ApiClient; id: string }) {
  const [flow, setFlow] = useState<FlowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    client.getFlow(id).then(setFlow, (e: unknown) => setError(message(e)));
  }, [client, id]);

  /** Runs one action; the answer replaces the flow, a failure shows and keeps what was there. */
  async function act(name: string, fn: () => Promise<FlowView>): Promise<boolean> {
    setBusy(name);
    setError(null);
    try {
      setFlow(await fn());
      return true;
    } catch (e) {
      setError(message(e));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!flow) {
    return (
      <main className="page narrow">
        <header className="topbar">
          <a className="btn-quiet" href="#/flows">
            ← 返回
          </a>
        </header>
        {error ? (
          <p className="error-box" role="alert">
            {error}
          </p>
        ) : (
          <p className="muted">讀取中…</p>
        )}
      </main>
    );
  }

  const next = nextStep(flow);
  return (
    <main className="page narrow">
      <header className="topbar">
        <a className="btn-quiet" href="#/flows">
          ← 返回
        </a>
        <h1>{flow.title}</h1>
      </header>
      <p className="small">
        {flow.state === 'done' ? '✓ 這一集全部完成了。' : `已完成 ${progressLabel(flow)} 步`}
        {next && <span className="muted"> · 下一步：{next.title}</span>}
      </p>
      {error && (
        <p className="error-box" role="alert">
          {error}
        </p>
      )}
      {flow.warnings.map((w) => (
        <p key={w} className="small cap-warn">
          ⚠ {w}
        </p>
      ))}
      <ol className="flow-steps">
        {flow.steps.map((s, i) => (
          <li key={s.key} className={`flow-step flow-step-${s.status}`}>
            <div className="flow-step-head">
              <span className="flow-step-no">{s.status === 'done' ? '✓' : i + 1}</span>
              <div>
                <strong>{s.title}</strong>
                <p className="muted small">{s.help}</p>
              </div>
            </div>
            <StepBody flow={flow} step={s} client={client} busy={busy} act={act} />
          </li>
        ))}
      </ol>
    </main>
  );
}

type Act = (name: string, fn: () => Promise<FlowView>) => Promise<boolean>;

function StepBody(p: {
  flow: FlowView;
  step: FlowStepView;
  client: ApiClient;
  busy: string | null;
  act: Act;
}) {
  const { flow, step, client, busy, act } = p;
  switch (step.key) {
    case 'notes':
      return <NotesStep flow={flow} client={client} busy={busy} act={act} />;
    case 'draft':
      return <DraftStep flow={flow} client={client} busy={busy} act={act} />;
    case 'schedule':
      return <ScheduleStep flow={flow} client={client} busy={busy} act={act} />;
    default:
      return <ManualStep flow={flow} step={step} client={client} busy={busy} act={act} />;
  }
}

type Common = { flow: FlowView; client: ApiClient; busy: string | null; act: Act };

function NotesStep({ flow, client, busy, act }: Common) {
  const [notes, setNotes] = useState(flow.notes);
  const [style, setStyle] = useState(flow.style);
  const [title, setTitle] = useState(flow.title);
  const dirty = notes !== flow.notes || style !== flow.style || title !== flow.title;
  return (
    <div className="flow-body">
      <label className="field">
        這一集的名稱（只是方便你找）
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} />
      </label>
      <label className="field">
        重點
        <textarea
          rows={6}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={8000}
          placeholder="這集聊了什麼、有哪些觀點、來賓是誰……"
        />
      </label>
      <details>
        <summary className="small">節目風格（選填，新的一集會沿用）</summary>
        <label className="field">
          <textarea
            rows={4}
            value={style}
            onChange={(e) => setStyle(e.target.value)}
            maxLength={4000}
            placeholder="例如：口吻輕鬆；描述結尾固定放訂閱提醒；標題不要太長。"
          />
        </label>
      </details>
      <button
        className="btn-primary"
        disabled={!dirty || busy !== null}
        onClick={() =>
          void act('save', () => client.saveFlowInputs(flow.id, { notes, style, title }))
        }
      >
        {busy === 'save' ? '儲存中…' : dirty ? '儲存' : '已儲存'}
      </button>
    </div>
  );
}

function DraftStep({ flow, client, busy, act }: Common) {
  const [title, setTitle] = useState(flow.chosen?.title ?? '');
  const [description, setDescription] = useState(flow.chosen?.description ?? '');
  const hasNotes = flow.notes.trim().length > 0;
  const saved =
    flow.chosen !== null && flow.chosen.title === title && flow.chosen.description === description;
  const pick = (o: FlowDraftOption) => {
    setTitle(o.title);
    setDescription(o.description);
  };
  return (
    <div className="flow-body">
      <button
        className="btn-secondary"
        disabled={!hasNotes || busy !== null}
        onClick={() => void act('generate', () => client.generateFlowDraft(flow.id))}
      >
        {busy === 'generate'
          ? 'AI 正在寫…（約 10 到 30 秒，可以先離開，回來看結果）'
          : flow.options.length > 0
            ? '重新擬三組'
            : '請 AI 擬三組'}
      </button>
      {!hasNotes && <p className="muted small">先在上一步寫下重點並儲存。</p>}
      {flow.options.length > 0 && (
        <ul className="flow-options">
          {flow.options.map((o, i) => (
            <li key={i} className="flow-option">
              <strong>{o.title}</strong>
              <p className="small flow-desc">{o.description}</p>
              <button className="btn-quiet" onClick={() => pick(o)}>
                用這組
              </button>
            </li>
          ))}
        </ul>
      )}
      {(flow.options.length > 0 || flow.chosen) && (
        <>
          <label className="field">
            要貼的標題
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </label>
          <label className="field">
            要貼的描述
            <textarea
              rows={8}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={5000}
            />
          </label>
          <button
            className="btn-primary"
            disabled={saved || title.trim() === '' || busy !== null}
            onClick={() =>
              void act('choose', () => client.chooseFlowDraft(flow.id, { title, description }))
            }
          >
            {saved ? '已選定' : busy === 'choose' ? '儲存中…' : '選定這組'}
          </button>
        </>
      )}
    </div>
  );
}

function ScheduleStep({ flow, client, busy, act }: Common) {
  const current = flow.publishAt;
  const [time, setTime] = useState(current?.slice(11) ?? flow.defaultTime);
  return (
    <div className="flow-body">
      {current && (
        <p className="ok-box">
          已排定：<strong>{formatPublishAt(current)}</strong>
        </p>
      )}
      <label className="field">
        時間
        <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
      </label>
      <div className="flow-slots">
        {flow.slots.map((s) => {
          const value = `${s.date}T${time}`;
          return (
            <button
              key={s.date}
              className={current === value ? 'btn-primary' : 'btn-secondary'}
              disabled={!time || busy !== null}
              onClick={() => void act('schedule', () => client.setFlowSchedule(flow.id, value))}
            >
              {s.label}
            </button>
          );
        })}
      </div>
      {current && (
        <button
          className="btn-quiet"
          disabled={busy !== null}
          onClick={() => void act('schedule', () => client.setFlowSchedule(flow.id, null))}
        >
          清除
        </button>
      )}
    </div>
  );
}

function CopyRow({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  return (
    <div className="flow-copy">
      <div>
        <span className="muted small">{label}</span>
        <p className="flow-copy-text">{text}</p>
      </div>
      <button
        className="btn-secondary"
        onClick={() =>
          void copyText(text).then((ok) => {
            setState(ok ? 'ok' : 'fail');
            setTimeout(() => setState('idle'), 2000);
          })
        }
      >
        {state === 'ok' ? '已複製' : state === 'fail' ? '複製失敗' : '複製'}
      </button>
    </div>
  );
}

function ManualStep({ flow, step, client, busy, act }: Common & { step: FlowStepView }) {
  const missing = step.kind === 'handoff' ? missingForHandoff(flow) : [];
  const done = step.status === 'done';
  return (
    <div className="flow-body">
      {step.kind === 'handoff' &&
        (missing.length > 0 ? (
          <p className="muted small">
            還缺：{missing.join('、')}。補上之後，這裡會出現可以複製的內容。
          </p>
        ) : (
          <>
            <CopyRow label="標題" text={flow.chosen!.title} />
            <CopyRow label="描述" text={flow.chosen!.description} />
            <CopyRow label="發佈時間" text={pasteablePublishAt(flow.publishAt!)} />
          </>
        ))}
      {step.link && (
        <a className="btn-secondary" href={step.link.url} target="_blank" rel="noreferrer">
          {step.link.label}
        </a>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={done}
          disabled={busy !== null}
          onChange={() =>
            void act(step.key, () => client.setFlowStepDone(flow.id, step.key, !done))
          }
        />
        <span>{step.kind === 'handoff' ? '我貼上並排程好了' : '這一步完成了'}</span>
      </label>
    </div>
  );
}
