-- Anomaly flags (technical-plan §7.6): accounts the scan thinks an admin should look at. One
-- open flag per account and kind; a new finding refreshes it.

create table economy_flags (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  kind text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by text,
  note text
);
create unique index economy_flags_open on economy_flags (account_id, kind) where reviewed_at is null;
