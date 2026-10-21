/**
 * Plain iCalendar (RFC 5545) text, which Apple Calendar, Google Calendar and Outlook all read.
 * Timed events are written in UTC so no time zone definitions are needed.
 */
export interface IcsEvent {
  uid: string;
  title: string;
  description: string;
  /** ISO date-time with offset, or YYYY-MM-DD when `allDay`. */
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  /** When the event was last changed; calendars use it to tell versions apart. */
  stamp: Date;
}

const escapeText = (s: string) =>
  s
    .replace(/\\/g, '\\\\')
    .replace(/[;,]/g, (c) => '\\' + c)
    .replace(/\r?\n/g, '\\n');

/** Lines longer than 75 bytes are split; every continuation line starts with one space. */
export function fold(line: string): string {
  const out: string[] = [];
  let current = '';
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > limit) {
      out.push(current);
      current = ' ';
      bytes = 1;
      limit = 75;
    }
    current += ch;
    bytes += size;
  }
  out.push(current);
  return out.join('\r\n');
}

const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
const dateOnly = (s: string) => s.replace(/-/g, '');
const validDate = (d: Date) => !Number.isNaN(d.getTime());

function addDays(day: string, n: number): string | null {
  const d = new Date(`${day}T00:00:00Z`);
  if (!validDate(d)) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The VEVENT lines for one event, or null when its dates cannot be read (it is left out). */
function eventLines(e: IcsEvent): string[] | null {
  const head = ['BEGIN:VEVENT', `UID:${e.uid}@littleboss`, `DTSTAMP:${utc(e.stamp)}`];
  let when: string[];
  if (e.allDay) {
    const first = e.startsAt.slice(0, 10);
    const last = e.endsAt ? e.endsAt.slice(0, 10) : first;
    const end = addDays(last >= first ? last : first, 1);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(first) || !end) return null;
    when = [`DTSTART;VALUE=DATE:${dateOnly(first)}`, `DTEND;VALUE=DATE:${dateOnly(end)}`];
  } else {
    const start = new Date(e.startsAt);
    if (!validDate(start)) return null;
    let end = e.endsAt ? new Date(e.endsAt) : new Date(start.getTime() + 60 * 60_000);
    if (!validDate(end) || end <= start) end = new Date(start.getTime() + 60 * 60_000);
    when = [`DTSTART:${utc(start)}`, `DTEND:${utc(end)}`];
  }
  const text = [`SUMMARY:${escapeText(e.title)}`];
  if (e.description) text.push(`DESCRIPTION:${escapeText(e.description)}`);
  return [...head, ...when, ...text, 'END:VEVENT'];
}

export function buildCalendar(events: IcsEvent[], name = 'little boss'): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//WeiHui Digital//little boss//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(name)}`,
  ];
  for (const e of events) {
    const l = eventLines(e);
    if (l) lines.push(...l);
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
