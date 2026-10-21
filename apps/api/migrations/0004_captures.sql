-- M2 second track: quick capture. One text in, several proposed items out; each item is approved
-- and written on its own, so one failure never blocks the rest.

create table captures (
  id                    uuid primary key default gen_random_uuid(),
  text                  text not null,
  state                 text not null check (state in ('queued', 'parsing', 'ready', 'failed')),
  client_request_id     text not null unique,
  -- Frozen when the capture is created: which AI, model and prompt version read the text.
  config                jsonb not null,
  error                 jsonb,
  questions             jsonb not null default '[]',
  attempt_count         integer not null default 0,
  estimated_cost_micro  bigint not null default 0,
  cost_micro            bigint,
  usage                 jsonb,
  prompt                jsonb,
  raw_output            text,
  created_at            timestamptz not null default now(),
  started_at            timestamptz,
  updated_at            timestamptz not null default now(),
  finished_at           timestamptz,
  reconciled_at         timestamptz
);
create index captures_recent on captures (created_at desc);
create index captures_active on captures (state) where state in ('queued', 'parsing');

create table capture_items (
  id             uuid primary key default gen_random_uuid(),
  capture_id     uuid not null references captures(id) on delete cascade,
  position       integer not null,
  kind           text not null check (kind in ('shopping', 'event')),
  origin         text not null check (origin in ('said', 'suggested')),
  status         text not null check (status in
                   ('proposed', 'needs_info', 'rejected', 'writing', 'saved', 'failed')),
  -- title, note, quantity, startsAt, endsAt, allDay, timeZone as the person currently sees them
  payload        jsonb not null,
  assumptions    jsonb not null default '[]',
  question       text not null default '',
  -- Hash of the payload the person approved; a later edit clears it.
  approved_hash  text,
  approved_at    timestamptz,
  result         jsonb,
  error          jsonb,
  created_at     timestamptz not null default now(),
  version        integer not null default 0,
  updated_at     timestamptz not null default now(),
  unique (capture_id, position)
);

-- The shopping list lives in little boss. One row per approved capture item (idempotent save).
create table shopping_items (
  id               uuid primary key default gen_random_uuid(),
  capture_item_id  uuid unique references capture_items(id) on delete set null,
  capture_id       uuid references captures(id) on delete set null,
  title            text not null,
  note             text not null default '',
  quantity         text not null default '',
  done             boolean not null default false,
  done_at          timestamptz,
  created_at       timestamptz not null default now()
);
create index shopping_open on shopping_items (done, created_at desc);

-- What the demo calendar "wrote" (only used when no real calendar is connected in demo mode).
create table demo_calendar_events (
  event_id    text primary key,
  title       text not null,
  starts_at   text not null,
  ends_at     text,
  all_day     boolean not null default false,
  created_at  timestamptz not null default now()
);
