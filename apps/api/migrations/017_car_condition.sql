-- Fuel and condition (Phase 7), kept with each car while it's in the garage: what it had when it
-- went back is what it comes out with.
alter table owned_cars
  add column fuel real not null default 1 check (fuel >= 0 and fuel <= 1),
  add column health real not null default 1 check (health >= 0 and health <= 1);
