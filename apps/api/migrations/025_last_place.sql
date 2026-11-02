-- Where a character was last, so they come back there however long they've been away (owner,
-- 2026-10-31). Null until they've played.
alter table characters
  add column last_x double precision,
  add column last_y double precision,
  add column last_z double precision,
  add column last_yaw double precision,
  add column last_place_at timestamptz;
