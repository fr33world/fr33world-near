-- Player safety (Phase 4). Blocks: an account hides a character (its chat, voice and name tag)
-- from itself; kept by the character's id, so a rename can't escape it. Reports: what a player
-- reported about a character, for admins to review.

create table blocks (
  account_id uuid not null references accounts (id),
  blocked_character uuid not null references characters (account_id),
  created_at timestamptz not null default now(),
  primary key (account_id, blocked_character)
);

create table reports (
  id bigserial primary key,
  reporter_id uuid not null references accounts (id),
  reported_character uuid not null references characters (account_id),
  reason text not null check (reason in ('harassment', 'hate', 'cheating', 'spam', 'other')),
  details text not null default '' check (length(details) <= 500),
  created_at timestamptz not null default now(),
  reviewed boolean not null default false
);
create index reports_open on reports (created_at desc) where not reviewed;
