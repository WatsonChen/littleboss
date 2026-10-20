-- Automatic discussion: the people (AIs) chosen for a discussion, who checks the conclusion, and the
-- bookkeeping that lets AI turns follow one another without the boss pressing anything.

alter table threads
  add column participants text[] not null default '{}',
  add column reviewer     text,
  add column max_rounds   integer not null default 3 check (max_rounds between 1 and 4);

alter table thread_messages
  -- On the boss's message that starts an automatic discussion: who speaks in which turn. Frozen at send.
  add column auto_plan       jsonb,
  -- On AI messages: position in the plan. (trigger_id, auto_turn) is unique, so a turn is created once.
  add column auto_turn       integer,
  add column auto_kind       text check (auto_kind in ('discussion', 'summary', 'review', 'review_request')),
  -- The AI's own verdict for a discussion turn: true = "nothing more worth adding".
  add column auto_done       boolean,
  -- The saved conclusion a reviewer was asked to check.
  add column review_asset_id uuid references assets(id) on delete set null,
  add column review_version  integer;

create unique index thread_messages_auto_turn
  on thread_messages (trigger_id, auto_turn) where auto_turn is not null;
create unique index thread_messages_review_once
  on thread_messages (review_asset_id, review_version)
  where role = 'agent' and auto_kind = 'review';
