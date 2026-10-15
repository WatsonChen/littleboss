import { createHash } from 'node:crypto';
import type { CalendarWriteInput } from './flow.js';

/** Hash of exactly what the person approves: content, destination and action. */
export function proposalHashFor(input: CalendarWriteInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        action: 'calendar.create',
        destination: 'google-calendar',
        title: input.title,
        startsAt: input.startsAt,
      }),
    )
    .digest('hex');
}
