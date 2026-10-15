-- Approvals live in our own database (not in the workflow engine), keyed by run and step.
-- A decision is stored at most once per key; the proposal_hash binds it to exactly what the
-- person saw (content + destination + action).
create table approvals (
  key           text primary key,
  proposal_hash text not null,
  decision      text not null check (decision in ('approved', 'rejected')),
  created_at    timestamptz not null default now()
);
