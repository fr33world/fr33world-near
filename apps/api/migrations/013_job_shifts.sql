-- A player's job shift in progress (Phase 6 jobs, apps/world jobs/), saved by the world server
-- at each step so it carries on after a reconnect or a server restart.

create table job_shifts (
  account_id uuid primary key references accounts (id),
  job text not null,
  shift text not null,
  state jsonb not null,
  updated_at timestamptz not null default now()
);
