-- Spike-only bookkeeping so the test process can observe a run without asking the engine.
create table if not exists spike_run_view (
  run_id          text primary key,
  workflow_run_id text,
  state           text not null,
  outcome         jsonb,
  completed_steps jsonb not null default '[]',
  step_executions jsonb not null default '{}',
  config          jsonb not null,
  updated_at      timestamptz not null default clock_timestamp()
);

-- Protection layer: which Inngest event started the run, and when we last asked Inngest about it.
alter table spike_run_view add column if not exists engine_event_id text;
alter table spike_run_view add column if not exists reconciled_at timestamptz;
