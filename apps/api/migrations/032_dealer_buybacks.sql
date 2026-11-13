-- Sol Motors' buybacks (dealer.ts; shared BUYBACK): the resale price chosen when a car was
-- bought, as a share of its worth, until it's put back on sale.
create table dealer_relists (
  token text primary key,
  share numeric(4, 3) not null check (share > 0),
  at timestamptz not null default now()
);
