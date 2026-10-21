-- Flows: a repeatable routine (the first is publishing a podcast episode) that the boss walks
-- through step by step, over several days. Steps are defined in code; here only the progress lives.

create table flows (
  id                 uuid primary key default gen_random_uuid(),
  template           text not null,
  title              text not null,
  client_request_id  text not null unique,
  notes              text not null default '',
  style              text not null default '',
  -- What the AI proposed last time: [{title, description}]
  options            jsonb not null default '[]',
  -- What the boss picked or edited: {title, description}
  chosen             jsonb,
  -- Local date and time, e.g. 2026-10-22T18:00 (Asia/Taipei)
  publish_at         text,
  -- Manual steps the boss ticked: {"auphonic": true}
  manual_done        jsonb not null default '{}',
  -- Set while an AI call for this flow is running, so two taps cannot start two calls.
  generating_since   timestamptz,
  ai_cost_micro      bigint not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index flows_recent on flows (updated_at desc);

-- One row per AI call (also failed ones), for the rolling 24-hour spending cap.
create table flow_ai_calls (
  id           uuid primary key default gen_random_uuid(),
  flow_id      uuid not null references flows(id) on delete cascade,
  agent_id     text not null,
  model        text not null,
  cost_micro   bigint not null default 0,
  usage        jsonb,
  raw_output   text,
  outcome      text not null,
  created_at   timestamptz not null default now()
);
create index flow_ai_calls_recent on flow_ai_calls (created_at desc);
