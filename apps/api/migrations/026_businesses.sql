-- Phase 17: businesses that run themselves on NEAR (D-41 to D-45). USDC is never in the `$`
-- ledger: the wallet contracts are the truth for it, and these tables are a work queue and a
-- mirror. Stock, orders and decisions live here; only money and its proof go on chain.

-- A business's working numbers. `markup` and `target` start from shared BUSINESSES; an AI may
-- move them inside shared AI_LIMITS.
create table businesses (
  id text primary key,
  account text not null unique,
  name text not null,
  markup numeric(5, 3) not null,
  target integer not null check (target > 0),
  last_tick timestamptz
);

create table business_stock (
  business text not null references businesses (id),
  good text not null,
  qty integer not null check (qty >= 0),
  primary key (business, good)
);

-- One business buying from another. Paid on chain first; the goods then wait for a carrier.
create table business_orders (
  id text primary key,
  buyer text not null references businesses (id),
  seller text not null references businesses (id),
  good text not null,
  qty integer not null check (qty > 0),
  amount bigint not null check (amount > 0),
  status text not null check (status in ('queued', 'paid', 'failed', 'delivered')),
  tx text,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index business_orders_due on business_orders (next_at) where status = 'queued';

-- A delivery a player can take for USDC, held in the buyer's wallet until it's done.
create table business_jobs (
  id text primary key,
  business text not null references businesses (id),
  order_id text not null references business_orders (id),
  amount bigint not null check (amount > 0),
  status text not null
    check (status in ('queued', 'open', 'assigning', 'assigned', 'releasing', 'paid', 'cancelling', 'cancelled')),
  worker uuid references accounts (id),
  worker_near text,
  tx text,
  attempts integer not null default 0,
  next_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index business_jobs_due on business_jobs (next_at)
  where status in ('queued', 'assigning', 'releasing', 'cancelling');
create unique index one_job_per_worker on business_jobs (worker)
  where status in ('assigning', 'assigned');

-- What was sold to players. USDC sales are confirmed against the chain before goods are handed
-- over; `$` sales are in the ledger and only count as demand here.
create table business_sales (
  id text primary key,
  business text not null references businesses (id),
  good text not null,
  qty integer not null check (qty > 0),
  currency text not null check (currency in ('usd', 'usdc')),
  amount bigint not null check (amount > 0),
  buyer uuid references accounts (id),
  status text not null check (status in ('pending', 'confirmed', 'expired')),
  tx text,
  created_at timestamptz not null default now()
);
create index business_sales_recent on business_sales (business, created_at);

-- Every decision and why: the rules' and the AI's, accepted or cut back.
create table business_decisions (
  id bigserial primary key,
  business text not null references businesses (id),
  at timestamptz not null default now(),
  source text not null check (source in ('rule', 'ai')),
  summary text not null,
  details jsonb not null default '{}'
);
create index business_decisions_recent on business_decisions (business, id desc);

-- A player's own NEAR account (the Privy embedded wallet's address).
create table near_wallets (
  account_id uuid primary key references accounts (id),
  near_account text not null unique,
  registered boolean not null default false,
  created_at timestamptz not null default now()
);

-- When the economy last ran, so a public trigger can't run it more than it should.
create table economy_ticks (
  id integer primary key default 1 check (id = 1),
  last_at timestamptz
);
insert into economy_ticks (id) values (1);
