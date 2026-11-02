-- Factions (Phase 9, D-26; shared FACTIONS): one membership per account, applications through
-- training (a quiz) and an interview to acceptance, and an audit of every faction action.
create table memberships (
  account_id uuid primary key references accounts (id),
  faction text not null,
  rank smallint not null check (rank between 1 and 5),
  joined_at timestamptz not null default now()
);
create index memberships_by_faction on memberships (faction, rank desc);

create table applications (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  faction text not null,
  -- training: the quiz to pass; interview: waiting for a recruiter; closed: decided or withdrawn.
  stage text not null check (stage in ('training', 'interview', 'accepted', 'rejected', 'withdrawn')),
  note text not null default '' check (length(note) <= 300),
  quiz_failed_at timestamptz,
  created_at timestamptz not null default now(),
  decided_by uuid references accounts (id),
  decided_at timestamptz
);
create unique index one_open_application on applications (account_id)
  where stage in ('training', 'interview');

create table faction_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  faction text not null,
  actor text not null,
  action text not null,
  target text not null default '',
  details text not null default ''
);
create index faction_audit_by_time on faction_audit (faction, at desc);
