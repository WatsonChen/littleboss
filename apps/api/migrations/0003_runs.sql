-- M2: runs. A run is one durable execution of a flow (here: handing a conclusion to an AI role).
-- Our tables are the source of truth for what a person sees; the workflow engine only drives it.

create table runs (
  id                 uuid primary key default gen_random_uuid(),
  thread_id          uuid references threads(id) on delete set null,
  kind               text not null,
  title              text not null,
  state              text not null check (state in (
                       'running', 'waiting_input', 'waiting_approval',
                       'succeeded', 'rejected', 'needs_reapproval', 'failed', 'cancelled')),
  -- Frozen when the run starts: later edits to roles, models or settings never change a running run.
  config             jsonb not null,
  -- The conclusion text and instruction as they were when the run was created.
  input              jsonb not null,
  outcome            jsonb,
  -- Estimated cost set aside for this run while it is active, so two runs started together cannot
  -- both pass the budget check. Once the run ends, only what was really spent counts.
  reserved_micro     bigint not null default 0,
  -- Makes creating a run idempotent (double tap, retry after a dropped connection).
  client_request_id  text,
  -- Which Inngest event started the run, and when we last asked the engine about it (reconcile).
  engine_event_id    text,
  reconciled_at      timestamptz,
  -- Only one worker drives a run at a time. A lease that runs out (worker died) can be taken over.
  lease_until        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  finished_at        timestamptz
);
create unique index runs_client_request
  on runs (thread_id, client_request_id) where client_request_id is not null;
create index runs_thread on runs (thread_id, created_at desc);
create index runs_active on runs (state) where state in ('running', 'waiting_input', 'waiting_approval');

-- One row per step that finished. This is also the memo that makes a replay skip finished work:
-- a step with a row here is never executed again, whichever engine drives the run.
create table run_steps (
  run_id       uuid not null references runs(id) on delete cascade,
  name         text not null,
  output       jsonb not null,
  usage        jsonb,
  cost_micro   bigint not null default 0,
  prompt       jsonb,
  executions   integer not null default 1,
  created_at   timestamptz not null default now(),
  primary key (run_id, name)
);

-- What a person returned by hand (first answer wins; a second submit is reported as already processed).
create table run_inputs (
  key         text primary key,
  payload     text not null,
  created_at  timestamptz not null default now()
);

-- Attempts per step, including attempts that failed before a row exists in run_steps.
create table run_step_attempts (
  run_id  uuid not null references runs(id) on delete cascade,
  name    text not null,
  count   integer not null default 0,
  last_error text,
  primary key (run_id, name)
);

-- Saving a deliverable is idempotent per run: at most one asset per run.
alter table assets add column run_id uuid unique references runs(id) on delete set null;
alter table assets add column source_asset_id uuid references assets(id) on delete set null;
