-- Cars players own (Phase 7's garage, started early: owner, 2026-10-30). Every account gets a
-- starter car the first time it asks for one; the dealership adds more later.
create table owned_cars (
  id bigserial primary key,
  account_id uuid not null references accounts (id),
  -- Index into shared CAR_MODELS, and a paint (unused by the current models).
  model smallint not null check (model >= 0),
  colour smallint not null default 0,
  starter boolean not null default false,
  created_at timestamptz not null default now()
);
create index owned_cars_by_account on owned_cars (account_id, id);
create unique index one_starter_car on owned_cars (account_id) where starter;
