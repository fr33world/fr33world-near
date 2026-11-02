-- Levels and rewards (Phase 6): a character's experience, and every reward they were given
-- (money and XP together, from a job stop, a sale, the tutorial), keyed so a replayed reward
-- is given once. The phone's progress app reads the history from here.

alter table characters add column xp bigint not null default 0 check (xp >= 0);

create table rewards (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  idempotency_key text not null unique,
  source text not null,
  reason text not null,
  cents bigint not null default 0 check (cents >= 0),
  xp int not null default 0 check (xp >= 0),
  created_at timestamptz not null default now()
);
create index rewards_by_account on rewards (account_id, id desc);
