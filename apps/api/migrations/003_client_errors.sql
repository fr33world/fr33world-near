-- Error reports from game clients (Phase 1: errors are visible). One row per distinct error
-- (fingerprint) with a count and the latest sample, so a crash hitting every player is one row,
-- not thousands; rows untouched for 30 days are pruned by the API.

create table client_errors (
  fingerprint text primary key,
  message text not null,
  sample jsonb not null,
  count integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index client_errors_recent on client_errors (last_seen desc);
