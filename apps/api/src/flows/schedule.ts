import type { FlowSlot } from '@littleboss/shared';

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];

/** Today's calendar date in a time zone, as year, month, day. */
export function localDate(now: Date, timeZone: string): { y: number; m: number; d: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day') };
}

/**
 * The next publishing days, starting tomorrow (today is usually too late to prepare an episode).
 * A calendar date has the same weekday everywhere, so this is plain date arithmetic.
 */
export function nextSlots(now: Date, timeZone: string, days: number[], count: number): FlowSlot[] {
  const t = localDate(now, timeZone);
  const out: FlowSlot[] = [];
  for (let i = 1; out.length < count && i <= 60; i += 1) {
    const day = new Date(Date.UTC(t.y, t.m - 1, t.d + i));
    if (!days.includes(day.getUTCDay())) continue;
    const date = day.toISOString().slice(0, 10);
    out.push({
      date,
      label: `週${WEEKDAY[day.getUTCDay()]} ${day.getUTCMonth() + 1}/${day.getUTCDate()}`,
    });
  }
  return out;
}

/** True for a real calendar date and a real time of day. */
export function validLocalDateTime(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === mo - 1 &&
    date.getUTCDate() === d &&
    h < 24 &&
    mi < 60
  );
}

/** Whether a local date and time (in `timeZone`) is already past. Compares as local wall time. */
export function isPast(local: string, now: Date, timeZone: string): boolean {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const nowLocal = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
  return local < nowLocal;
}
