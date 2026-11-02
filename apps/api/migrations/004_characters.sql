-- Characters (Phase 3): one per account, made after the age gate and the Terms. The name is
-- what everyone sees in the city, unique whatever its capitals; the appearance is the
-- shared 32-bit code (packages/shared character.ts), checked by the API before it is stored.

create table characters (
  account_id uuid primary key references accounts (id),
  name text not null check (length(name) between 5 and 29),
  age smallint not null check (age between 18 and 80),
  appearance integer not null check (appearance >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index characters_name_unique on characters (lower(name));
