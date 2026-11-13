-- Cars as assets on NEAR (owner, 2026-11-13; shared assets.ts, contracts/cars). Once minted,
-- the cars contract is the truth for who owns a car: these tables are its queue and mirror.

-- `car_chain` (from 023) is the mint queue again: 'mint' waits to go on chain, 'done' is
-- minted, `wallet` is who holds it on chain now and `asset` its token id.
-- A car whose token is held by a NEAR account no player has linked is away from the game:
-- out of every garage until it comes back to a linked wallet.
alter table owned_cars add column away boolean not null default false;

-- A listing can ask `$` (`price`, cents, as before), USDC (`micro`), or both: the buyer chooses.
-- The USDC price mirrors the cars contract's listing, and a sale there is final whatever this
-- table says. A minted car's `$` price needs its owner's offer on chain (`offer_to_game`), so
-- the game can hand the car over when someone pays `$`.
alter table car_listings alter column price drop not null;
alter table car_listings add column micro bigint check (micro > 0);
alter table car_listings add constraint listing_has_a_price
  check (price is not null or micro is not null);
alter table car_listings add column paid_in text check (paid_in in ('usd', 'usdc'));
alter table car_listings add column tx text;

-- When the chain was last read for every car, so a garage can ask for a fresh look cheaply.
create table car_sync (
  id integer primary key default 1 check (id = 1),
  last_at timestamptz
);
insert into car_sync (id) values (1);
