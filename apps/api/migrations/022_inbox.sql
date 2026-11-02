-- The in-game inbox (Phase 10): notices for a player, kept for when they're next on (faction
-- decisions and ranks, fines). Read ones are kept a while, then pruned.
create table notices (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  text text not null check (length(text) <= 200),
  at timestamptz not null default now(),
  read boolean not null default false
);
create index notices_by_account on notices (account_id, id desc);
