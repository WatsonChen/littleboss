import type { FlowView } from '@littleboss/shared';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** "2026-10-22T18:00" → "10/22（週四）18:00". Unreadable text is shown as it is. */
export function formatPublishAt(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local);
  if (!m) return local;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return `${Number(m[2])}/${Number(m[3])}（週${WEEKDAY[day.getUTCDay()]}）${m[4]}`;
}

/** Done steps over all steps, e.g. "3/6". */
export function progressLabel(flow: Pick<FlowView, 'steps'>): string {
  const done = flow.steps.filter((s) => s.status === 'done').length;
  return `${done}/${flow.steps.length}`;
}

/** The first step still to do, or null when every step is done. */
export function nextStep(flow: Pick<FlowView, 'steps'>) {
  return flow.steps.find((s) => s.status === 'todo') ?? null;
}

/** What is still missing before the last step can be pasted into another app. */
export function missingForHandoff(
  flow: Pick<FlowView, 'chosen' | 'publishAt'>,
): ('標題與描述' | '發佈時間')[] {
  const out: ('標題與描述' | '發佈時間')[] = [];
  if (!flow.chosen) out.push('標題與描述');
  if (!flow.publishAt) out.push('發佈時間');
  return out;
}

/** The text a podcast host expects for a date and time, e.g. "2026/10/22 18:00". */
export function pasteablePublishAt(local: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(local);
  return m ? `${m[1]}/${m[2]}/${m[3]} ${m[4]}` : local;
}

/** Copies text. Falls back to a hidden textarea where the clipboard API is not allowed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
