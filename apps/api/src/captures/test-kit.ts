import { createKit, type Kit } from '../discussion/test-kit.js';
import { ModelGateway } from '../discussion/gateway.js';
import { createPricing } from '../discussion/pricing.js';
import { Roster } from '../discussion/roster.js';
import { InlineRunEngine } from '../runs/engine.js';
import { DemoCalendar, type CalendarClient } from './calendar.js';
import { CaptureRepository } from './repository.js';
import { CaptureService, type CaptureServiceConfig } from './service.js';

export interface CaptureKit extends Kit {
  captures: CaptureService;
  engine: InlineRunEngine;
  repo: CaptureRepository;
  calendar: CalendarClient;
  restart(): { captures: CaptureService; engine: InlineRunEngine };
}

type Behaviour = NonNullable<Parameters<typeof createKit>[0]>;

/** 2026-10-19 19:00 in Taipei. */
export const NOW = new Date('2026-10-19T11:00:00Z');

export const modelJson = (items: unknown[], questions: string[] = []): string =>
  JSON.stringify({ items, questions });

export const shopping = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'shopping',
  origin: 'said',
  title,
  note: '',
  quantity: '',
  startsAt: null,
  endsAt: null,
  allDay: false,
  assumptions: [],
  question: '',
  ...extra,
});

export const event = (
  title: string,
  startsAt: string | null,
  extra: Record<string, unknown> = {},
) => ({
  kind: 'event',
  origin: 'said',
  title,
  note: '',
  quantity: '',
  startsAt,
  endsAt: null,
  allDay: false,
  assumptions: [],
  question: '',
  ...extra,
});

export function buildCaptures(
  kit: Kit,
  opts: {
    config?: Partial<CaptureServiceConfig>;
    calendar?: (demo: DemoCalendar) => CalendarClient;
  } = {},
) {
  const roster = new Roster({ ANTHROPIC_API_KEY: 'test-a', OPENAI_API_KEY: 'test-o' });
  const pricing = createPricing({});
  const gateway = new ModelGateway(roster, kit.providers, pricing);
  const repo = new CaptureRepository(kit.pool);
  const engine = new InlineRunEngine();
  const demo = new DemoCalendar(kit.pool);
  const calendar = opts.calendar ? opts.calendar(demo) : demo;
  const captures = new CaptureService({
    repo,
    roster,
    gateway,
    pricing,
    calendar,
    engine,
    clock: () => NOW,
    config: { retryDelayMs: 0, ...opts.config },
  });
  return { captures, engine, repo, calendar };
}

export async function createCaptureKit(
  behaviour: Behaviour = {},
  opts: Parameters<typeof buildCaptures>[1] = {},
): Promise<CaptureKit> {
  const kit = await createKit(behaviour);
  await kit.pool.query('truncate captures cascade');
  await kit.pool.query('truncate demo_calendar_events');
  await kit.pool.query('truncate shopping_items');
  const built = buildCaptures(kit, opts);
  return {
    ...kit,
    ...built,
    restart: () => {
      const b = buildCaptures(kit, opts);
      return { captures: b.captures, engine: b.engine };
    },
  };
}

let n = 0;
export const cid = () => `cap-req-${Date.now()}-${n++}`;
