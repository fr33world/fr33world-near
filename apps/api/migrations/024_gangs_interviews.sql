-- Interviews on the boss's computer, and a fresh set of questions after a failed try (owner,
-- 2026-10-31).
alter table applications add column interview_at timestamptz;
alter table applications add column interview_by text;
alter table applications add column quiz_seed integer not null default 0;

-- Gangs players start themselves (shared GANG), beside the Vipers and Kings.
create table gangs (
  id bigserial primary key,
  name text not null check (length(name) between 3 and 24),
  tag text not null check (length(tag) between 2 and 5),
  leader uuid not null references accounts (id),
  created_at timestamptz not null default now()
);
create unique index gangs_name_unique on gangs (lower(name));
create unique index gangs_tag_unique on gangs (lower(tag));

-- One gang per account; `accepted` false is a request waiting for the leader.
create table gang_members (
  account_id uuid primary key references accounts (id),
  gang_id bigint not null references gangs (id) on delete cascade,
  accepted boolean not null default false,
  joined_at timestamptz not null default now()
);
create index gang_members_by_gang on gang_members (gang_id);

-- The weekly board: `gang` is 'vipers', 'kings' or 'g<id>'.
create table gang_scores (
  gang text not null,
  week date not null,
  points integer not null default 0,
  primary key (gang, week)
);
