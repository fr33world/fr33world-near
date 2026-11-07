-- Daily rewards (owner's launch-eve list): the login streak, the free spin, daily tasks and
-- level bonuses, each claimed once under its key. In-game `$`, XP and items only: nothing here
-- touches USDC, and a spin costs nothing.
insert into ledger_accounts (kind, code) values ('faucet', 'faucet:daily');

create table daily_claims (
  account_id uuid not null references accounts (id),
  key text not null,
  kind text not null,
  streak int not null default 0,
  created_at timestamptz not null default now(),
  primary key (account_id, key)
);
create index daily_claims_recent on daily_claims (account_id, kind, created_at desc);
