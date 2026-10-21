import type { Pool } from '../db/pool.js';

export interface CalendarEventInput {
  /** Stable per item: writing the same event twice can never create two. */
  eventId: string;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  allDay: boolean;
  timeZone: string;
}

export type CalendarWrite =
  | {
      status: 'created' | 'exists';
      destination: 'google-calendar' | 'demo-calendar' | 'little-boss-calendar';
      demo: boolean;
      link: string | null;
    }
  /** No calendar is connected: nothing was attempted. */
  | { status: 'not_connected' }
  /** The calendar said no. `retryable` means trying again may work. */
  | { status: 'failed'; code: string; reason: string; retryable: boolean };

/**
 * The only door to a calendar. Throwing means "we do not know whether it was written" (timeout,
 * dropped connection): the caller reports that honestly and a retry is safe because `eventId`
 * makes the write idempotent.
 */
export interface CalendarClient {
  readonly kind: 'google' | 'demo' | 'app' | 'none';
  insert(e: CalendarEventInput): Promise<CalendarWrite>;
}

export class NoCalendar implements CalendarClient {
  readonly kind = 'none' as const;
  async insert(): Promise<CalendarWrite> {
    return { status: 'not_connected' };
  }
}

/**
 * The event lives in little boss itself: the approved capture item is the record. Phones get it
 * through an .ics link or the subscription feed, so any calendar app works without an account here.
 */
export class InAppCalendar implements CalendarClient {
  readonly kind = 'app' as const;
  async insert(): Promise<CalendarWrite> {
    return {
      status: 'created',
      destination: 'little-boss-calendar',
      demo: false,
      link: null,
    };
  }
}

/**
 * For trying the app without a Google account: remembers the event in our own table and says
 * plainly that nothing reached a real calendar.
 */
export class DemoCalendar implements CalendarClient {
  readonly kind = 'demo' as const;
  constructor(private readonly pool: Pool) {}

  async insert(e: CalendarEventInput): Promise<CalendarWrite> {
    const { rowCount } = await this.pool.query(
      `insert into demo_calendar_events (event_id, title, starts_at, ends_at, all_day)
       values ($1,$2,$3,$4,$5) on conflict (event_id) do nothing`,
      [e.eventId, e.title, e.startsAt, e.endsAt, e.allDay],
    );
    return {
      status: (rowCount ?? 0) > 0 ? 'created' : 'exists',
      destination: 'demo-calendar',
      demo: true,
      link: null,
    };
  }
}

/** Event ids must be 5-1024 chars of a-v and 0-9 for Google; hex digits with a prefix qualify. */
export const eventIdFor = (captureItemId: string) => `lb${captureItemId.replace(/-/g, '')}`;
