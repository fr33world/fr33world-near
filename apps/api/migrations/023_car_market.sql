-- Phase 11: car certificates on Solana and the in-game car market (D-09, D-22).
-- A car's certificate: queued when a full account buys it (deliver first, mint after), then
-- minted to the owner's wallet; moved when the car changes hands. The worker retries with
-- backoff; reconciliation compares the chain with this table.
create table car_chain (
  car_id bigint primary key references owned_cars (id),
  status text not null check (status in ('mint', 'transfer', 'done', 'mismatch')),
  wallet text,
  asset text,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now()
);
create index car_chain_due on car_chain (next_at) where status in ('mint', 'transfer');

-- Cars for sale between players, for $. One open listing a car; a car bought here can't be
-- listed again until resell_at.
create table car_listings (
  id bigserial primary key,
  car_id bigint not null references owned_cars (id),
  seller uuid not null references accounts (id),
  price bigint not null check (price > 0),
  status text not null check (status in ('open', 'sold', 'withdrawn')),
  buyer uuid references accounts (id),
  listed_at timestamptz not null default now(),
  closed_at timestamptz
);
create unique index one_open_listing on car_listings (car_id) where status = 'open';
alter table owned_cars add column resell_at timestamptz;
