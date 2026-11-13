-- `$` top-ups with USDC, one way (owner, 2026-11-13; shared assets.ts TOPUP). USDC is still
-- never in the `$` ledger: a top-up is paid only once the chain shows the USDC arrived.

-- `$` bought with USDC: confirmed against the dealership wallet on chain before any `$` is paid.
create table usdc_topups (
  id text primary key,
  account_id uuid not null references accounts (id),
  near_account text not null,
  micro bigint not null check (micro > 0),
  cents bigint not null check (cents > 0),
  status text not null check (status in ('pending', 'confirmed', 'expired')),
  tx text,
  created_at timestamptz not null default now()
);
create index usdc_topups_account on usdc_topups (account_id, created_at desc);

insert into ledger_accounts (kind, code) values ('faucet', 'faucet:topup');

-- The food chain no longer runs on USDC: the Hot Meal is sold for `$` like the rest.
insert into business_stock (business, good, qty)
  select 'market', 'meal', 20 where exists (select 1 from businesses where id = 'market')
  on conflict (business, good) do nothing;
