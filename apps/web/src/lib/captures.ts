import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureItemStatus, CaptureView } from '@littleboss/shared';
import type { ApiClient } from '../api';

export const newCaptureRequestId = () =>
  `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export function itemStatusLabel(s: CaptureItemStatus): string {
  switch (s) {
    case 'proposed':
      return '等你核准';
    case 'needs_info':
      return '還缺資料';
    case 'rejected':
      return '你說不要';
    case 'writing':
      return '寫入中';
    case 'saved':
      return '已完成';
    case 'failed':
      return '沒成功';
  }
}

/** Minutes the zone is ahead of UTC at the given instant. */
function zoneOffsetMinutes(timeZone: string, at: number): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - Math.floor(at / 1000) * 1000) / 60000);
}

/** "2026-10-20T15:00" typed in the zone → "2026-10-20T15:00:00+08:00". Null if not a date-time. */
export function toOffsetString(local: string, timeZone: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.parse(`${local}:00Z`);
  if (Number.isNaN(guess)) return null;
  // Two passes settle the offset even next to a daylight-saving change.
  let off = zoneOffsetMinutes(timeZone, guess);
  off = zoneOffsetMinutes(timeZone, guess - off * 60_000);
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${m[1]}T${m[2]}:00${sign}${hh}:${mm}`;
}

/** The value a datetime-local box wants: the wall-clock part of an ISO string with an offset. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? iso.slice(0, 16) : '';
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** "10/20（二）15:00" — read straight from the string so the browser's own zone never shifts it. */
export function formatWhen(iso: string | null, allDay: boolean): string {
  if (!iso) return '時間未定';
  const m = /^\d{4}-(\d{2})-(\d{2})(?:T(\d{2}:\d{2}))?/.exec(iso);
  if (!m) return iso;
  const y = Number(iso.slice(0, 4));
  const wd = WEEK[new Date(Date.UTC(y, Number(m[1]) - 1, Number(m[2]))).getUTCDay()];
  const day = `${Number(m[1])}/${Number(m[2])}（${wd}）`;
  return allDay || !m[3] ? `${day} 全天` : `${day} ${m[3]}`;
}

const POLL_MS = 2500;

/** One capture; refreshes while the AI is still reading it. */
export function useCapture(client: ApiClient, id: string) {
  const [capture, setCapture] = useState<CaptureView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const c = await client.getCapture(id);
      if (alive.current) {
        setCapture(c);
        setError(null);
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client, id]);

  useEffect(() => {
    alive.current = true;
    void refresh();
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  const working = capture?.state === 'queued' || capture?.state === 'parsing';
  useEffect(() => {
    if (!working) return;
    const t = setTimeout(() => void refresh(), POLL_MS);
    return () => clearTimeout(t);
  }, [working, capture, refresh]);

  return { capture, error, refresh, setCapture };
}
