-- What players own besides money and cars (Phase 8): the pistol licence, weapons and rounds.
-- One row per item: 'licence', 'weapon:<n>' (count 1), 'rounds:<n>' (how many).
create table inventory (
  account_id uuid not null references accounts (id),
  item text not null,
  count integer not null check (count >= 0),
  updated_at timestamptz not null default now(),
  primary key (account_id, item)
);

-- Who went down to whom (Phase 8 kill log), for staff reviewing reports of random killing.
create table kills (
  id bigserial primary key,
  at timestamptz not null default now(),
  killer uuid references accounts (id),
  victim uuid references accounts (id),
  killer_name text not null,
  victim_name text not null,
  weapon smallint not null,
  x real not null,
  z real not null
);
create index kills_by_time on kills (at desc);
create index kills_by_killer on kills (killer, at desc);
