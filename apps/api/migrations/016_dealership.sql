-- Cars bought at the dealership (Phase 7): each points at the ledger transaction that paid for
-- it, so a purchase replayed with the same key gives back the same car instead of a second one.
alter table owned_cars add column purchase_tx bigint unique references ledger_transactions (id);
