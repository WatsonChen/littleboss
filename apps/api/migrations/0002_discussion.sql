-- M1 discussion room: threads, messages (user notes, pasted background, AI calls) and the
-- versioned "conclusion" assets a person selects from a discussion.
-- Money is stored as micro-USD (1 USD = 1,000,000) in integers so sums never drift.

create table threads (
  id                 uuid primary key default gen_random_uuid(),
  title              text not null,
  budget_limit_micro bigint not null check (budget_limit_micro >= 0),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table thread_messages (
  id                    uuid primary key default gen_random_uuid(),
  thread_id             uuid not null references threads(id) on delete cascade,
  seq                   integer not null,
  -- user: what the person typed; context: pasted conversation or background summary; agent: one AI call
  role                  text not null check (role in ('user', 'context', 'agent')),
  agent_id              text,
  -- the message this one answers or checks (e.g. the proposal a reviewer is checking)
  reply_to_id           uuid references thread_messages(id),
  -- the person's message that started this call (agent messages only)
  trigger_id            uuid references thread_messages(id),
  content               text not null default '',
  status                text not null check (
                          status in ('sent', 'queued', 'running', 'succeeded', 'failed', 'timed_out', 'bad_format')),
  -- Makes sending idempotent: the same request id never creates a second message or a second call.
  client_request_id     text,
  -- Ids of the messages this call was shown. Parallel calls from one request share the same list.
  seen_message_ids      uuid[] not null default '{}',
  -- Frozen model settings used for this call (provider, model, role prompt version).
  agent_config          jsonb,
  -- The exact prompt that was sent, saved when the call starts.
  prompt                jsonb,
  -- Memory entries injected into the prompt. Always empty in M1; filled from M3.
  injected_memory       jsonb not null default '[]',
  usage                 jsonb,
  estimated_cost_micro  bigint,
  cost_micro            bigint,
  cost_is_estimate      boolean not null default true,
  error                 jsonb,
  attempt_count         integer not null default 0,
  -- One entry per failed attempt, so a retry never erases what went wrong before.
  attempts              jsonb not null default '[]',
  edited_by_user        boolean not null default false,
  created_at            timestamptz not null default now(),
  -- last time the call was put in the queue (changes on retry); used to spot lost dispatches
  queued_at             timestamptz,
  started_at            timestamptz,
  finished_at           timestamptz,
  unique (thread_id, seq)
);
create unique index thread_messages_client_request
  on thread_messages (thread_id, client_request_id) where client_request_id is not null;
create index thread_messages_thread_seq on thread_messages (thread_id, seq);

create table assets (
  id         uuid primary key default gen_random_uuid(),
  thread_id  uuid references threads(id) on delete set null,
  kind       text not null default 'conclusion',
  title      text not null,
  created_at timestamptz not null default now()
);

-- Versions are never overwritten: editing a conclusion adds a new version.
create table asset_versions (
  id                 uuid primary key default gen_random_uuid(),
  asset_id           uuid not null references assets(id) on delete cascade,
  version            integer not null,
  content            text not null,
  source_message_ids uuid[] not null default '{}',
  created_at         timestamptz not null default now(),
  unique (asset_id, version)
);
