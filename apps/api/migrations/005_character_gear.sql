-- What a character wears besides the outfit (Phase 3): hat, eyewear, chain, watch, bag and
-- their colours, as the shared 17-bit code (packages/shared gear.ts), checked by the API.

alter table characters add column gear integer not null default 0 check (gear >= 0);
