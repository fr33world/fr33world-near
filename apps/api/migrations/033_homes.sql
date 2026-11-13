-- Homes players own (owner, 2026-11-13; shared HOMES and HOME_ASSETS): the 36 hill villas, each
-- bought for $ at its door and minted to the buyer's own NEAR wallet as its title deed. Once
-- minted, the homes contract is the truth for who owns a home: these tables are its mirror.

-- One row a villa that has been bought (shared HOMES index). A home whose deed is held by a
-- NEAR account no player has linked is `away`: nobody's in the game until it comes back.
create table owned_homes (
  villa integer primary key check (villa >= 0),
  account_id uuid not null references accounts (id),
  purchase_tx bigint not null unique references ledger_transactions (id),
  away boolean not null default false,
  bought_at timestamptz not null default now()
);
create index owned_homes_by_account on owned_homes (account_id);

-- The mint queue and mirror, as car_chain is for cars: 'mint' waits to go on chain, 'done' is
-- minted; `wallet` is who holds it on chain now and `asset` its token id.
create table home_chain (
  villa integer primary key references owned_homes (villa),
  status text not null check (status in ('mint', 'done')),
  wallet text,
  asset text not null unique,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  updated_at timestamptz not null default now()
);
create index home_chain_due on home_chain (next_at) where status = 'mint';
