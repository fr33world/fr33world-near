-- The starter car becomes a rental (owner, 2026-10-31): free for an account's first three days,
-- then it goes back to Sol Motors. Cars already given as starters get three days from now.
alter table owned_cars add column expires_at timestamptz;
update owned_cars set expires_at = now() + interval '3 days' where starter;
